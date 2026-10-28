/** A failure the MCP client should see as a tool error (isError), with a message that is safe to show. */
export class McpToolError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = 'McpToolError';
    }
}

/** The caller's daily MCP creation allowance is spent; nothing was created. */
export class McpQuotaExceededError extends McpToolError {
    constructor(readonly kind: 'jobs' | 'features', readonly limit: number) {
        super(
            limit === 0
                ? `Creating ${kind} through MCP is disabled (daily limit 0). Nothing was created.`
                : `Daily MCP limit reached: at most ${limit} ${kind} per UTC day, counting everything you created through MCP today. Nothing was created.`,
            429,
        );
        this.name = 'McpQuotaExceededError';
    }
}
