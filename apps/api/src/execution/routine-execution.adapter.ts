import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AgentInstructionsService } from './agent-instructions.service.js';
import { ExecutionError, type ExecutionErrorKind } from './execution.error.js';
import {
    JobPayloadSchema,
    type ExecutionPort,
    type ExecutionTarget,
    type ExecutionResult,
    type JobPayload,
    type PreparedPrompt,
    type PromptContext,
} from './execution.port.js';
import { prepareJobPrompt, promptTooLargeError } from './job-prompt.js';

const FIRE_TIMEOUT_MS = 30_000;
/** A Retry-After further away than this is ignored in favour of the configured backoff. */
const MAX_RESET_MS = 7 * 24 * 60 * 60 * 1000;

const FireResponseSchema = z.object({
    type: z.literal('routine_fire'),
    claude_code_session_id: z.string(),
    claude_code_session_url: z.string(),
});

function httpErrorKind(status: number): ExecutionErrorKind {
    if ([400, 401, 403, 404].includes(status)) return 'config';
    if (status >= 500) return 'transient';
    return 'invalid_response';
}

/**
 * The reset time from a Retry-After header (delay in seconds or an HTTP date), or null when absent, invalid, in the past or
 * unreasonably far away.
 */
export function parseRetryAfter(value: string | null, now = new Date()): Date | null {
    const raw = value?.trim();
    if (!raw) return null;
    const at = /^\d+$/.test(raw) ? new Date(now.getTime() + Number(raw) * 1000) : new Date(raw);
    const ms = at.getTime() - now.getTime();
    return Number.isNaN(ms) || ms <= 0 || ms > MAX_RESET_MS ? null : at;
}

@Injectable()
export class RoutineExecutionAdapter implements ExecutionPort {
    constructor(private readonly instructions: AgentInstructionsService) { }

    /** The one renderer behind both preview and fire. Throws a config error only when the instructions cannot be read. */
    prepare(payload: JobPayload, context?: PromptContext): PreparedPrompt {
        return prepareJobPrompt(JobPayloadSchema.parse(payload), this.instructions.get(), context);
    }

    async fire(target: ExecutionTarget, input: JobPayload | PreparedPrompt, context?: PromptContext): Promise<ExecutionResult> {
        const { fullName, executorName, fireUrl, token } = target;
        const via = `${fullName} on executor "${executorName}"`;
        if (!fireUrl || !token) {
            throw new ExecutionError(`Executor "${executorName}" has no fire URL or token`, 'config');
        }

        const prompt = 'prepared' in input ? input : this.prepare(input, context);
        if (!prompt.fits) throw promptTooLargeError(prompt, prompt.payload.jobId);
        const { text, instructionsVersion } = prompt;

        let res: Response;
        try {
            res = await fetch(fireUrl, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'anthropic-beta': 'experimental-cc-routine-2026-04-01',
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ text }),
                signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
            });
        } catch (err) {
            // Only the error name is reported; messages could echo request details.
            const name = err instanceof Error ? err.name : 'Error';
            throw new ExecutionError(`Routine fire request failed for ${via}: ${name}`, 'transient');
        }

        if (res.status === 429) {
            throw new ExecutionError(
                `Routine fire for ${via} hit a usage limit (HTTP 429)`,
                'executor_exhausted',
                parseRetryAfter(res.headers.get('retry-after')),
            );
        }
        if (!res.ok) {
            throw new ExecutionError(
                `Routine fire for ${via} failed with HTTP ${res.status}`,
                httpErrorKind(res.status),
            );
        }

        let body: unknown;
        try {
            body = await res.json();
        } catch {
            throw new ExecutionError(`Routine fire for ${via} returned invalid JSON`, 'invalid_response');
        }
        const result = FireResponseSchema.safeParse(body);
        if (!result.success) {
            throw new ExecutionError(`Routine fire for ${via} returned an unexpected response`, 'invalid_response');
        }
        return {
            sessionId: result.data.claude_code_session_id,
            sessionUrl: result.data.claude_code_session_url,
            instructionsVersion,
        };
    }
}
