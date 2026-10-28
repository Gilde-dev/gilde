/**
 * config: the repo's routine setup is wrong (needs a human, retrying won't help).
 * transient: network, timeout, rate limit or server error.
 * invalid_response: the routine API answered with something unusable.
 * executor_exhausted: the executor's account hit a usage limit (HTTP 429). It says nothing about the job: the executor is
 *   marked exhausted until `resetAt` (or the configured backoff when null) and the job is requeued without using an attempt.
 * prompt_too_large: this job's prompt cannot fit the limit even after trimming; it says nothing about the repo, so it
 *   parks only that job and is never retried.
 */
export type ExecutionErrorKind = 'config' | 'transient' | 'invalid_response' | 'executor_exhausted' | 'prompt_too_large';

export class ExecutionError extends Error {
    constructor(
        message: string,
        readonly kind: ExecutionErrorKind,
        /** Only for executor_exhausted: the reset time from the response, null when it gave none. */
        readonly resetAt: Date | null = null,
    ) {
        super(message);
        this.name = 'ExecutionError';
    }

    get retryable(): boolean {
        return this.kind === 'transient';
    }
}
