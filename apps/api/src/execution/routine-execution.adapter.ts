import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { ExecutionError, type ExecutionErrorKind } from './execution.error.js';
import {
    JobPayloadSchema,
    type ExecutionPort,
    type ExecutionRepo,
    type ExecutionResult,
    type JobPayload,
} from './execution.port.js';

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
    async fire(repo: ExecutionRepo, payload: JobPayload): Promise<ExecutionResult> {
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

        const parsed = JobPayloadSchema.parse(payload);
        const text =
            `Gilde job ${parsed.jobId} (attempt ${parsed.attempt}). Execute it as described in your routine instructions.\n\n` +
            JSON.stringify(parsed);

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
        };
    }
}
