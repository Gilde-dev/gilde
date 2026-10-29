import { Injectable } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import type { McpTestErrorKind } from './project-mcp.dto.js';
import type { ProjectMcpToolMode } from './project-mcp-tool.entity.js';

export const MCP_TEST_TIMEOUT_MS = 10_000;
const MAX_TOOLS = 200;
const MAX_PAGES = 10;
const MAX_DESCRIPTION = 2000;

export interface DiscoveredTool {
    name: string;
    description: string;
    /** `read` only when the server's annotations say `readOnlyHint: true`. */
    mode: ProjectMcpToolMode;
}

/** A connection failure with a short, fixed-text message: it never carries the token, the URL or server-provided text. */
export class McpConnectionError extends Error {
    constructor(readonly kind: McpTestErrorKind, message: string) {
        super(message);
        this.name = 'McpConnectionError';
    }
}

/** Talks to a remote MCP server over Streamable HTTP. Initializes and lists tools; never calls one. */
@Injectable()
export class ProjectMcpConnector {

    async listTools(url: string, token: string | null, timeoutMs = MCP_TEST_TIMEOUT_MS): Promise<DiscoveredTool[]> {
        const abort = new AbortController();
        const transport = new StreamableHTTPClientTransport(new URL(url), {
            requestInit: {
                redirect: 'error',
                signal: abort.signal,
                ...(token && { headers: { Authorization: `Bearer ${token}` } }),
            },
            reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
        });
        const client = new Client({ name: 'gilde', version: '1.0.0' }, { capabilities: {} });
        const timer = setTimeout(() => abort.abort(), timeoutMs);
        try {
            await client.connect(transport, { timeout: timeoutMs, signal: abort.signal });
            const tools: DiscoveredTool[] = [];
            let cursor: string | undefined;
            for (let page = 0; page < MAX_PAGES; page++) {
                const result = await client.listTools(cursor ? { cursor } : {}, { timeout: timeoutMs, signal: abort.signal });
                for (const tool of result.tools) {
                    if (tools.length >= MAX_TOOLS) break;
                    tools.push({
                        name: tool.name.slice(0, 200),
                        description: (tool.description ?? '').slice(0, MAX_DESCRIPTION),
                        mode: tool.annotations?.readOnlyHint === true ? 'read' : 'write',
                    });
                }
                cursor = result.nextCursor;
                if (!cursor) break;
            }
            return tools;
        } catch (e) {
            throw this.classify(e, abort.signal.aborted);
        } finally {
            clearTimeout(timer);
            abort.abort();
            await client.close().catch(() => undefined);
        }
    }

    private classify(e: unknown, timedOut: boolean): McpConnectionError {
        if (e instanceof McpConnectionError) return e;
        if (e instanceof StreamableHTTPError) {
            if (e.code === 401 || e.code === 403) return new McpConnectionError('auth', `The server refused the token (HTTP ${e.code})`);
            if (typeof e.code === 'number' && e.code >= 400) return new McpConnectionError('not_mcp', `The server answered HTTP ${e.code}; this does not look like an MCP endpoint`);
            return new McpConnectionError('not_mcp', 'The server did not speak MCP over Streamable HTTP');
        }
        if (e instanceof McpError) {
            // RequestTimeout (-32001) and ConnectionClosed (-32000) come from the SDK itself; the rest is the server answering MCP.
            if (e.code === -32001) return new McpConnectionError('timeout', 'The server did not respond in time');
            if (e.code === -32000) return new McpConnectionError('unreachable', 'The connection was closed by the server');
            return new McpConnectionError('not_mcp', 'The server answered with an MCP error');
        }
        if (timedOut) return new McpConnectionError('timeout', 'The server did not respond in time');
        if (e instanceof Error && e.name === 'UnauthorizedError') return new McpConnectionError('auth', 'The server requires authentication; set a valid token');
        if (e instanceof TypeError) return new McpConnectionError('unreachable', 'The server could not be reached');
        return new McpConnectionError('not_mcp', 'The response was not a valid MCP response');
    }
}
