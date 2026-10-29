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

/** A tool as the server announces it right now, with the input schema the model needs. */
export interface LiveTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
    /** The text content items joined; other content kinds are replaced by a fixed marker. */
    text: string;
    /** The server flagged the result as an error. Its text is not passed on. */
    isError: boolean;
}

/** An open, reusable connection to one MCP server. Calls carry their own timeout; `close` is safe to repeat. */
export interface McpSession {
    listLiveTools(timeoutMs: number): Promise<LiveTool[]>;
    callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpCallResult>;
    close(): Promise<void>;
}

const MAX_RESULT_TEXT = 200_000;

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

    /** Opens a connection that stays usable for several calls. The caller closes it. */
    async openSession(url: string, token: string | null, timeoutMs: number): Promise<McpSession> {
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
        } catch (e) {
            const timedOut = abort.signal.aborted;
            abort.abort();
            await client.close().catch(() => undefined);
            throw this.classify(e, timedOut);
        } finally {
            clearTimeout(timer);
        }
        return {
            listLiveTools: async (timeout) => {
                try {
                    const tools: LiveTool[] = [];
                    let cursor: string | undefined;
                    for (let page = 0; page < MAX_PAGES; page++) {
                        const result = await client.listTools(cursor ? { cursor } : {}, { timeout });
                        for (const tool of result.tools) {
                            if (tools.length >= MAX_TOOLS) break;
                            tools.push({
                                name: tool.name.slice(0, 200),
                                description: (tool.description ?? '').slice(0, MAX_DESCRIPTION),
                                inputSchema: tool.inputSchema as Record<string, unknown>,
                            });
                        }
                        cursor = result.nextCursor;
                        if (!cursor) break;
                    }
                    return tools;
                } catch (e) {
                    throw this.classify(e, false);
                }
            },
            callTool: async (name, args, timeout) => {
                try {
                    const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
                    const content = (result as { content?: unknown }).content;
                    if (!Array.isArray(content)) throw new McpConnectionError('not_mcp', 'The response was not a valid MCP response');
                    const parts: string[] = [];
                    let size = 0;
                    for (const item of content as { type?: unknown; text?: unknown }[]) {
                        const part = item?.type === 'text' && typeof item.text === 'string' ? item.text : '[non-text content omitted]';
                        parts.push(part);
                        size += part.length;
                        if (size > MAX_RESULT_TEXT) break;
                    }
                    return { text: parts.join('\n').slice(0, MAX_RESULT_TEXT), isError: result.isError === true };
                } catch (e) {
                    throw this.classify(e, false);
                }
            },
            close: async () => {
                abort.abort();
                await client.close().catch(() => undefined);
            },
        };
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
