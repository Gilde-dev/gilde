import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { computeCost, parsePrices } from '../usage/usage-pricing.js';

import { DEFAULT_AGENT_LOG_MAX_CHARS, agentLogMaxChars } from './agent-run.config.js';
import { AgentRun, type AgentRunAgent, type AgentRunOutcome, type AgentRunTrigger } from './agent-run.entity.js';
import { redactAndCap } from './agent-run.redact.js';
import { AgentToolCall } from './agent-tool-call.entity.js';

export interface AgentRunInit {
    agentId: AgentRunAgent;
    triggerKind: AgentRunTrigger;
    triggerRefType?: string | null;
    triggerRefId?: string | null;
    actorUserId?: string | null;
    projectId?: string | null;
    model?: string | null;
    linkedTable?: string | null;
    linkedId?: string | null;
    /** The owner ends the run itself (a worker): the Mastra `onFinish` then only adds tokens and cost. */
    managed?: boolean;
    startedAt?: Date;
}

export interface AgentRunEnd {
    outcome?: AgentRunOutcome;
    reason?: string | null;
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedInputTokens?: number | null;
    triggerRefType?: string | null;
    triggerRefId?: string | null;
    linkedTable?: string | null;
    linkedId?: string | null;
    projectId?: string | null;
}

export interface RecordedToolCall {
    name: string;
    input?: unknown;
    output?: unknown;
    durationMs?: number | null;
    error?: unknown;
}

const REASON_MAX = 500;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One run being recorded. Every method returns at once and never throws: the writes are queued behind each other (the row
 * exists before it is updated or gets tool calls) and a failed write is logged and dropped.
 */
export class AgentRunHandle {
    private tail: Promise<unknown> = Promise.resolve();
    private ended = false;

    constructor(
        readonly id: string,
        readonly managed: boolean,
        private readonly recorder: AgentRunRecorder,
        private readonly runs: Repository<AgentRun>,
        private readonly toolCalls: Repository<AgentToolCall>,
        private readonly logger: Logger,
        row: AgentRun,
    ) {
        this.enqueue('start', () => this.runs.insert(row));
    }

    get hasEnded(): boolean {
        return this.ended;
    }

    toolCall(call: RecordedToolCall): void {
        try {
            const max = this.recorder.maxChars();
            const row = this.toolCalls.create({
                runId: this.id,
                toolName: String(call.name).slice(0, 128),
                input: call.input === undefined ? null : redactAndCap(call.input, max),
                output: call.output === undefined ? null : redactAndCap(call.output, max),
                durationMs: call.durationMs === undefined || call.durationMs === null ? null : Math.round(call.durationMs),
                error: call.error === undefined || call.error === null ? null : redactAndCap(message(call.error), max),
            });
            this.enqueue('tool call', () => this.toolCalls.insert(row));
        } catch (error) {
            this.logger.warn(`Recording a tool call failed: ${message(error)}`);
        }
    }

    /** Ends the run. A later call only adds the fields it carries (tokens arrive after the outcome, or the owner overrides it). */
    end(end: AgentRunEnd): void {
        try {
            const patch: Partial<AgentRun> = {};
            if (!this.ended) patch.endedAt = new Date();
            this.ended = true;
            if (end.outcome !== undefined) patch.outcome = end.outcome;
            if (end.reason !== undefined) patch.reason = end.reason === null ? null : redactAndCap(end.reason, REASON_MAX);
            if (end.model) patch.model = end.model.slice(0, 128);
            for (const key of ['triggerRefType', 'triggerRefId', 'linkedTable', 'linkedId', 'projectId'] as const) {
                if (end[key] !== undefined && end[key] !== null) (patch as Record<string, unknown>)[key] = end[key];
            }
            const input = end.inputTokens ?? undefined, output = end.outputTokens ?? undefined;
            if (input !== undefined) patch.inputTokens = input;
            if (output !== undefined) patch.outputTokens = output;
            if (input !== undefined && end.model) {
                const cost = computeCost(parsePrices(process.env.LLM_PRICES), end.model, { inputTokens: input, cachedInputTokens: end.cachedInputTokens ?? 0, outputTokens: output ?? 0 });
                if (cost !== null) patch.costUsd = cost;
            }
            this.enqueue('end', () => this.runs.update({ id: this.id }, patch));
        } catch (error) {
            this.logger.warn(`Ending a run record failed: ${message(error)}`);
        }
    }

    /** Resolves when the queued writes are done (tests and shutdown); never rejects. */
    settled(): Promise<void> {
        return this.tail.then(() => undefined, () => undefined);
    }

    private enqueue(what: string, write: () => Promise<unknown>): void {
        this.tail = this.tail.then(write).catch((error: unknown) => this.logger.warn(`Recording (${what}) failed: ${message(error)}`));
        this.recorder.track(this.tail);
    }
}

/**
 * Writes the uniform run log (`agent_runs`, `agent_tool_calls`). Recording is best effort and off the recorded run's path:
 * `begin` returns a handle synchronously, nothing is awaited by the caller, and errors are logged and swallowed.
 */
@Injectable()
export class AgentRunRecorder {
    private readonly logger = new Logger('AgentRuns');
    private readonly pending = new Set<Promise<unknown>>();

    constructor(
        @InjectRepository(AgentRun) private readonly runs: Repository<AgentRun>,
        @InjectRepository(AgentToolCall) private readonly toolCalls: Repository<AgentToolCall>,
    ) { }

    /** Starts a run record. Never throws: when even building the record fails, the handle is a no-op. */
    begin(init: AgentRunInit): AgentRunHandle {
        const id = randomUUID();
        try {
            const row = this.runs.create({
                id,
                agentId: init.agentId,
                triggerKind: init.triggerKind,
                triggerRefType: init.triggerRefType ?? null,
                triggerRefId: init.triggerRefId ?? null,
                actorUserId: init.actorUserId ?? null,
                projectId: init.projectId ?? null,
                startedAt: init.startedAt ?? new Date(),
                endedAt: null,
                outcome: null,
                reason: null,
                model: init.model ?? null,
                inputTokens: null,
                outputTokens: null,
                costUsd: null,
                linkedTable: init.linkedTable ?? null,
                linkedId: init.linkedId ?? null,
            });
            return new AgentRunHandle(id, init.managed ?? false, this, this.runs, this.toolCalls, this.logger, row);
        } catch (error) {
            this.logger.warn(`Starting a run record failed: ${message(error)}`);
            return noopHandle(id, init.managed ?? false);
        }
    }

    /** A run that is recorded after the fact (a refused request, a finished MCP call). */
    complete(init: AgentRunInit, end: AgentRunEnd, calls: RecordedToolCall[] = []): AgentRunHandle {
        const handle = this.begin(init);
        for (const call of calls) handle.toolCall(call);
        handle.end(end);
        return handle;
    }

    /** Ends the open run linked to a per-agent record (a coding-agent job run, ended by a webhook long after it started). Never throws. */
    async endLinked(linkedTable: string, linkedId: string, end: AgentRunEnd): Promise<void> {
        try {
            const run = await this.runs.findOne({ where: { linkedTable, linkedId, endedAt: IsNull() }, order: { startedAt: 'DESC' } });
            if (!run) return;
            const patch: Partial<AgentRun> = { endedAt: new Date() };
            if (end.outcome !== undefined) patch.outcome = end.outcome;
            if (end.reason !== undefined) patch.reason = end.reason === null ? null : redactAndCap(end.reason, REASON_MAX);
            await this.runs.update({ id: run.id, endedAt: IsNull() }, patch);
        } catch (error) {
            this.logger.warn(`Ending the run record of ${linkedTable} ${linkedId} failed: ${message(error)}`);
        }
    }

    /** The cap for recorded text. An invalid AGENT_LOG_MAX_CHARS must not switch the log off: the default is used and the problem is logged. */
    maxChars(): number {
        try {
            return agentLogMaxChars();
        } catch (error) {
            this.logger.warn(`${message(error)}; using ${DEFAULT_AGENT_LOG_MAX_CHARS}`);
            return DEFAULT_AGENT_LOG_MAX_CHARS;
        }
    }

    /** Waits for all queued writes (tests, shutdown). */
    async flush(): Promise<void> {
        await Promise.allSettled([...this.pending]);
    }

    track(promise: Promise<unknown>): void {
        this.pending.add(promise);
        void promise.finally(() => this.pending.delete(promise));
    }
}

function noopHandle(id: string, managed: boolean): AgentRunHandle {
    const noop = { toolCall: () => undefined, end: () => undefined, settled: () => Promise.resolve(), hasEnded: false, id, managed };
    return noop as unknown as AgentRunHandle;
}
