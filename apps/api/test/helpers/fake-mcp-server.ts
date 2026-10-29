import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface FakeMcpServer {
  /** `http://127.0.0.1:<port>/mcp` */
  url: string;
  /** Names of the tools that were actually called (a test must leave this empty). */
  calls: string[];
  /** Arguments of each call, parallel to `calls`. */
  callArgs: Record<string, unknown>[];
  /** Authorization headers received, in order. */
  authorizations: (string | undefined)[];
  close(): Promise<void>;
}

export type FakeMcpMode = 'mcp' | 'html' | 'unauthorized' | 'forbidden' | 'not-found' | 'hang' | 'redirect';

interface Options {
  mode?: FakeMcpMode;
  /** When set, requests without `Authorization: Bearer <token>` get a 401. */
  token?: string;
  /** Tool names to register. Defaults to a read-only `search` and an unannotated `create_page`. */
  tools?: { name: string; description?: string; readOnly?: boolean | 'absent' }[];
  /** Text a tool answers with (default `called <name>`). */
  results?: Record<string, string>;
  /** Tools that answer with `isError: true`. */
  failing?: string[];
  /** Delay before a tool answers, in milliseconds. */
  callDelayMs?: number;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

/** A real Streamable HTTP MCP server (stateless) on a loopback port, for tests of the registry and the agents' tool layer. */
export async function startFakeMcpServer(options: Options = {}): Promise<FakeMcpServer> {
  const mode = options.mode ?? 'mcp';
  const tools = options.tools ?? [
    { name: 'search', description: 'Search the knowledge base', readOnly: true },
    { name: 'create_page', description: 'Create a page', readOnly: 'absent' },
  ];
  const calls: string[] = [];
  const callArgs: Record<string, unknown>[] = [];
  const authorizations: (string | undefined)[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      authorizations.push(req.headers.authorization);
      if (mode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }).end('<html>hello</html>'); return; }
      if (mode === 'not-found') { res.writeHead(404).end('nope'); return; }
      if (mode === 'forbidden') { res.writeHead(403).end('forbidden'); return; }
      if (mode === 'unauthorized') { res.writeHead(401).end('unauthorized'); return; }
      if (mode === 'redirect') { res.writeHead(307, { location: 'http://127.0.0.1:1/elsewhere' }).end(); return; }
      if (mode === 'hang') return;
      if (options.token && req.headers.authorization !== `Bearer ${options.token}`) { res.writeHead(401).end('unauthorized'); return; }

      const mcp = new McpServer({ name: 'fake', version: '1.0.0' });
      for (const tool of tools) {
        const annotations = tool.readOnly === 'absent' ? undefined : { readOnlyHint: tool.readOnly === true };
        mcp.registerTool(tool.name, {
          description: tool.description ?? tool.name,
          inputSchema: { query: z.string().optional() },
          ...(annotations && { annotations }),
        }, async (args: Record<string, unknown>) => {
          calls.push(tool.name);
          callArgs.push(args);
          if (options.callDelayMs) await new Promise((r) => setTimeout(r, options.callDelayMs));
          const text = options.results?.[tool.name] ?? `called ${tool.name}`;
          return { content: [{ type: 'text' as const, text }], ...(options.failing?.includes(tool.name) && { isError: true }) };
        });
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, await readBody(req));
    })().catch(() => { if (!res.headersSent) res.writeHead(500).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    callArgs,
    authorizations,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
