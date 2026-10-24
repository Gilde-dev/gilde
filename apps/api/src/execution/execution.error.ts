/**
 * config: the repo's routine setup is wrong (needs a human, retrying won't help).
 * transient: network, timeout, rate limit or server error.
 * invalid_response: the routine API answered with something unusable.
 */
export type ExecutionErrorKind = 'config' | 'transient' | 'invalid_response';

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
