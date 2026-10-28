import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AgentInstructionsService } from './agent-instructions.service.js';
import { ExecutionError, type ExecutionErrorKind } from './execution.error.js';
import {
    JobPayloadSchema,
    type ExecutionPort,
    type ExecutionRepo,
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

    async fire(repo: ExecutionRepo, input: JobPayload | PreparedPrompt, context?: PromptContext): Promise<ExecutionResult> {
        if (!repo.routineFireUrl || !repo.routineTokenEnv) {
            throw new ExecutionError(`Repo ${repo.fullName} has no routine configured`, 'config');
        }
        const token = process.env[repo.routineTokenEnv];
        if (!token) {
            throw new ExecutionError(
                `Environment variable ${repo.routineTokenEnv} is not set for repo ${repo.fullName}`,
                'config',
            );
        }

        const prompt = 'prepared' in input ? input : this.prepare(input, context);
        if (!prompt.fits) throw promptTooLargeError(prompt, prompt.payload.jobId);
        const { text, instructionsVersion } = prompt;

        let res: Response;
        try {
            res = await fetch(repo.routineFireUrl, {
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
            throw new ExecutionError(`Routine fire request failed for ${repo.fullName}: ${name}`, 'transient');
        }

        if (!res.ok) {
            throw new ExecutionError(
                `Routine fire for ${repo.fullName} failed with HTTP ${res.status}`,
                httpErrorKind(res.status),
            );
        }

        let body: unknown;
        try {
            body = await res.json();
        } catch {
            throw new ExecutionError(`Routine fire for ${repo.fullName} returned invalid JSON`, 'invalid_response');
        }
        const result = FireResponseSchema.safeParse(body);
        if (!result.success) {
            throw new ExecutionError(`Routine fire for ${repo.fullName} returned an unexpected response`, 'invalid_response');
        }
        return {
            sessionId: result.data.claude_code_session_id,
            sessionUrl: result.data.claude_code_session_url,
            instructionsVersion,
        };
    }
}
