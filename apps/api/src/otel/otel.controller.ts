import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { Public } from '../common/public.decorator.js';

import type { OtlpExportResponse } from './agent-usage.dto.js';
import { OtelIngestGuard } from './otel-ingest.guard.js';
import { OTEL_RATE_TTL_MS, otelRateLimit } from './otel.config.js';
import { OtelService } from './otel.service.js';

/**
 * OTLP/HTTP JSON receiver for Claude Code. @Public() only keeps the global JwtAuthGuard out of the way:
 * OtelIngestGuard (bearer OTEL_INGEST_TOKEN) is the authentication. Throttled per client address and route:
 * OTEL_INGEST_RATE_LIMIT requests per minute (default 120), then 429 with Retry-After, which OTLP exporters retry.
 */
@Controller('/v1/otel/v1')
@UseGuards(ThrottlerGuard, OtelIngestGuard)
@Throttle({ default: { limit: () => otelRateLimit(), ttl: OTEL_RATE_TTL_MS } })
export class OtelController {
    constructor(private readonly otel: OtelService) { }

    @Public()
    @Post('logs')
    @HttpCode(200)
    logs(@Body() body: unknown): Promise<OtlpExportResponse> {
        return this.otel.ingestLogs(body);
    }

    @Public()
    @Post('metrics')
    @HttpCode(200)
    metrics(@Body() body: unknown): OtlpExportResponse {
        return this.otel.ingestMetrics(body);
    }
}
