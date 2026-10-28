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

const FireResponseSchema = z.object({
    type: z.literal('routine_fire'),
    claude_code_session_id: z.string(),
    claude_code_session_url: z.string(),
});

function httpErrorKind(status: number): ExecutionErrorKind {
    if ([400, 401, 403, 404].includes(status)) return 'config';
    if (status === 429 || status >= 500) return 'transient';
    return 'invalid_response';
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
