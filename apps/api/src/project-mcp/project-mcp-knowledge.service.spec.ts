import type { ProjectMcpService } from './project-mcp.service.js';
import { ProjectMcpKnowledgeService } from './project-mcp-knowledge.service.js';
import type { ProjectMcpServer } from './project-mcp-server.entity.js';
import type { ProjectMcpToolsService } from './project-mcp-tools.service.js';

const limits = { budgetChars: 6000, snippetChars: 1500 };
const server = (over: Partial<ProjectMcpServer> = {}) =>
    ({ id: 's1', projectId: 'p1', name: 'Notion', enabled: true, knowledgeEnabled: true, knowledgeTool: 'search', knowledgeQueryArg: 'query', tokenLast4: null, ...over }) as ProjectMcpServer;

function setup(servers: ProjectMcpServer[], tool: object | null = { allowed: true, mode: 'read' }, call?: (s: ProjectMcpServer, t: string, a: Record<string, unknown>) => Promise<{ text: string } | { error: string }>) {
    const find = vi.fn(async () => servers);
    const findOneBy = vi.fn(async () => tool);
    const callForText = vi.fn(call ?? (async () => ({ text: JSON.stringify([{ title: 'Doc', url: 'https://w/1', content: 'body' }]) })));
    const recordFailure = vi.fn(async () => undefined);
    const mcpTools = { callForText, limits: { timeoutMs: 50 } } as unknown as ProjectMcpToolsService;
    const service = new ProjectMcpKnowledgeService({ find } as never, { findOneBy } as never, mcpTools, { recordFailure } as unknown as ProjectMcpService);
    return { service, find, callForText, recordFailure };
}

describe('ProjectMcpKnowledgeService', () => {
    it('queries only knowledge-enabled servers of the project, with title and task cut to 1000 characters', async () => {
        const { service, find, callForText } = setup([server()]);
        const knowledge = await service.collect('p1', { title: 'Title', task: 'x'.repeat(5000) }, limits);
        expect(find).toHaveBeenCalledWith({ where: { projectId: 'p1', enabled: true, knowledgeEnabled: true }, order: { name: 'ASC' } });
        const query = (callForText.mock.calls[0] as unknown[])[2] as { query: string };
        expect(query.query).toHaveLength(1000);
        expect(query.query.startsWith('Title\nxxx')).toBe(true);
        expect(knowledge?.snippets).toMatchObject([{ server: 'Notion', tool: 'search', ref: 'https://w/1', title: 'Doc' }]);
    });

    it('puts the query in the configured argument', async () => {
        const { service, callForText } = setup([server({ knowledgeQueryArg: 'q' })]);
        await service.collect('p1', { title: 'A', task: 'B' }, limits);
        expect(callForText).toHaveBeenCalledWith(expect.anything(), 'search', { q: 'A\nB' });
    });

    it('makes no call without servers or with a budget of 0', async () => {
        const none = setup([]);
        expect(await none.service.collect('p1', { title: 'A', task: 'B' }, limits)).toBeNull();
        const off = setup([server()]);
        expect(await off.service.collect('p1', { title: 'A', task: 'B' }, { budgetChars: 0, snippetChars: 1500 })).toBeNull();
        expect(off.find).not.toHaveBeenCalled();
    });

    it('skips a server whose tool is no longer an allowed read tool and records it', async () => {
        for (const tool of [null, { allowed: false, mode: 'read' }, { allowed: true, mode: 'write' }]) {
            const { service, callForText, recordFailure } = setup([server()], tool);
            expect(await service.collect('p1', { title: 'A', task: 'B' }, limits)).toBeNull();
            expect(callForText).not.toHaveBeenCalled();
            expect(recordFailure).toHaveBeenCalledWith('s1', expect.stringMatching(/allowed read-only tool/));
        }
    });

    it('skips a slow server at the timeout and keeps the snippets of the others', async () => {
        const slow = server({ id: 's1', name: 'Slow' });
        const fast = server({ id: 's2', name: 'Fast' });
        const { service, recordFailure } = setup([slow, fast], { allowed: true, mode: 'read' }, async (s) =>
            s.id === 's1' ? new Promise(() => undefined) : { text: 'fast answer' });
        const knowledge = await service.collect('p1', { title: 'A', task: 'B' }, limits);
        expect(knowledge?.snippets.map((s) => s.server)).toEqual(['Fast']);
        expect(recordFailure).toHaveBeenCalledWith('s1', 'The knowledge query timed out');
    });

    it('never throws: a server that errors, a call that rejects and a registry failure all give no snippets', async () => {
        const errored = setup([server()], { allowed: true, mode: 'read' }, async () => ({ error: 'The MCP tool call failed' }));
        expect(await errored.service.collect('p1', { title: 'A', task: 'B' }, limits)).toBeNull();
        const rejected = setup([server()], { allowed: true, mode: 'read' }, async () => { throw new Error('boom'); });
        expect(await rejected.service.collect('p1', { title: 'A', task: 'B' }, limits)).toBeNull();
        const broken = setup([server()]);
        broken.find.mockRejectedValueOnce(new Error('db down'));
        expect(await broken.service.collect('p1', { title: 'A', task: 'B' }, limits)).toBeNull();
    });
});
