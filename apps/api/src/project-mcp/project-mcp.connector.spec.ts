import { startFakeMcpServer, type FakeMcpServer } from '../../test/helpers/fake-mcp-server.js';

import { McpConnectionError, ProjectMcpConnector } from './project-mcp.connector.js';

describe('ProjectMcpConnector', () => {
    const connector = new ProjectMcpConnector();
    let fake: FakeMcpServer | undefined;
    afterEach(async () => { await fake?.close(); fake = undefined; });

    const failure = async (promise: Promise<unknown>): Promise<McpConnectionError> => {
        const e = await promise.then(() => null, (err: unknown) => err);
        expect(e).toBeInstanceOf(McpConnectionError);
        return e as McpConnectionError;
    };

    it('lists the tools without calling any and sends the bearer token', async () => {
        fake = await startFakeMcpServer({ token: 'secret-token-1234' });
        const tools = await connector.listTools(fake.url, 'secret-token-1234');
        expect(tools).toEqual([
            { name: 'search', description: 'Search the knowledge base', mode: 'read' },
            { name: 'create_page', description: 'Create a page', mode: 'write' },
        ]);
        expect(fake.calls).toEqual([]);
        expect(fake.authorizations.every((a) => a === 'Bearer secret-token-1234')).toBe(true);
    });

    it('defaults a tool to write unless readOnlyHint is exactly true', async () => {
        fake = await startFakeMcpServer({ tools: [
            { name: 'a', readOnly: true }, { name: 'b', readOnly: false }, { name: 'c', readOnly: 'absent' },
        ] });
        const modes = Object.fromEntries((await connector.listTools(fake.url, null)).map((t) => [t.name, t.mode]));
        expect(modes).toEqual({ a: 'read', b: 'write', c: 'write' });
    });

    it.each([
        ['unauthorized', 'auth'],
        ['forbidden', 'auth'],
        ['not-found', 'not_mcp'],
        ['html', 'not_mcp'],
    ] as const)('classifies a %s server as %s', async (mode, kind) => {
        fake = await startFakeMcpServer({ mode });
        const e = await failure(connector.listTools(fake.url, 'secret-token-1234'));
        expect(e.kind).toBe(kind);
        expect(e.message).not.toContain('secret-token-1234');
        expect(e.message).not.toContain(fake.url);
    });

    it('rejects a wrong token as an authentication failure', async () => {
        fake = await startFakeMcpServer({ token: 'right-token' });
        expect((await failure(connector.listTools(fake.url, 'wrong-token'))).kind).toBe('auth');
    });

    it('reports an unreachable server', async () => {
        fake = await startFakeMcpServer();
        const url = fake.url;
        await fake.close();
        fake = undefined;
        expect((await failure(connector.listTools(url, null))).kind).toBe('unreachable');
    });

    it('times out on a server that never answers', async () => {
        fake = await startFakeMcpServer({ mode: 'hang' });
        const started = Date.now();
        expect((await failure(connector.listTools(fake.url, null, 300))).kind).toBe('timeout');
        expect(Date.now() - started).toBeLessThan(3000);
    });

    it('does not follow redirects (the token must not travel to another host)', async () => {
        fake = await startFakeMcpServer({ mode: 'redirect' });
        const e = await failure(connector.listTools(fake.url, 'secret-token-1234'));
        expect(['unreachable', 'not_mcp']).toContain(e.kind);
    });
});
