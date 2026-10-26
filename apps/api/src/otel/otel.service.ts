import { BadRequestException, Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';

import type { AgentUsageDto, OtlpExportResponse } from './agent-usage.dto.js';
import { AgentUsage } from './agent-usage.entity.js';
import { toAgentUsageDto } from './agent-usage.mapper.js';
import { otelIngestConfig } from './otel.config.js';
import { OtlpEnvelopeError, parseOtlpLogs, validateOtlpMetrics, type ParsedAgentUsage } from './otel-parser.js';

const INSERT_CHUNK = 50;

@Injectable()
export class OtelService implements OnModuleInit {
    private readonly logger = new Logger(OtelService.name);

    constructor(@InjectRepository(AgentUsage) private readonly repo: Repository<AgentUsage>) { }

    onModuleInit(): void {
        const config = otelIngestConfig();
        if (config.state === 'invalid') this.logger.warn(`${config.reason}: the OTLP ingest routes are disabled (404)`);
    }

    /** Stores the api_request events of an ExportLogsServiceRequest. Throws 400 for a malformed envelope, 503 when storage fails. */
    async ingestLogs(body: unknown): Promise<OtlpExportResponse> {
        const { records, rejected } = parseLogsOrBadRequest(body);
        await this.insertIgnoringDuplicates(records);
        if (rejected === 0) return {};
        return { partialSuccess: { rejectedLogRecords: rejected, errorMessage: `${rejected} api_request record(s) were malformed and not stored` } };
    }

    /** Metrics are validated and acknowledged, never stored (the log events carry the same usage). */
    ingestMetrics(body: unknown): OtlpExportResponse {
        try {
            validateOtlpMetrics(body);
        } catch (e) {
            throw badRequest(e);
        }
        return {};
    }

    async listBySession(sessionId: string): Promise<AgentUsageDto[]> {
        const rows = await this.repo.find({ where: { sessionId }, order: { eventAt: 'ASC', eventKey: 'ASC' } });
        return rows.map(toAgentUsageDto);
    }

    /**
     * INSERT ... ON CONFLICT DO NOTHING on the unique event_key (also what SQLite's INSERT OR IGNORE does), so retries and
     * concurrent duplicate requests are safe without a read first. All chunks commit together: a failure acknowledges nothing,
     * and the exporter retries the whole request.
     */
    private async insertIgnoringDuplicates(records: ParsedAgentUsage[]): Promise<void> {
        const unique = [...new Map(records.map((r) => [r.eventKey, r])).values()];
        if (unique.length === 0) return;
        try {
            await this.repo.manager.transaction(async (m) => {
                for (let i = 0; i < unique.length; i += INSERT_CHUNK) {
                    const rows = unique.slice(i, i + INSERT_CHUNK).map((r) => ({ id: randomUUID(), runId: null, jobId: null, attribution: null, ...r }));
                    await m.createQueryBuilder().insert().into(AgentUsage).values(rows).orIgnore().execute();
                }
            });
        } catch (e) {
            // Only the error class and driver code are logged: driver messages and query parameters can echo row values.
            const code = (e as { driverError?: { code?: string } }).driverError?.code;
            this.logger.error(`Storing agent usage failed (${(e as Error).name}${code ? ` ${code}` : ''})`);
            throw new ServiceUnavailableException('Could not store the telemetry, retry later');
        }
    }
}

function parseLogsOrBadRequest(body: unknown) {
    try {
        return parseOtlpLogs(body);
    } catch (e) {
        throw badRequest(e);
    }
}

function badRequest(e: unknown): Error {
    if (e instanceof OtlpEnvelopeError) return new BadRequestException(e.message);
    throw e;
}
