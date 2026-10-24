export class ExecutionError extends Error {
    constructor(
        message: string,
        readonly retryable: boolean,
    ) {
        super(message);
        this.name = 'ExecutionError';
    }
}
