/**
 * config: the repo's routine setup is wrong (needs a human, retrying won't help).
 * transient: network, timeout, rate limit or server error.
 * invalid_response: the routine API answered with something unusable.
 * prompt_too_large: this job's prompt cannot fit the limit even after trimming; it says nothing about the repo, so it
 *   parks only that job and is never retried.
 */
export type ExecutionErrorKind = 'config' | 'transient' | 'invalid_response' | 'prompt_too_large';

export class ExecutionError extends Error {
    constructor(
        message: string,
        readonly kind: ExecutionErrorKind,
    ) {
        super(message);
        this.name = 'ExecutionError';
    }

    get retryable(): boolean {
        return this.kind === 'transient';
    }
}
