import { RequestContext } from '@mastra/core/request-context';

import { COPILOT_INSTRUCTIONS } from './copilot.instructions.js';
import { createCodeTools, MAX_FILE_CHARS, MAX_SEARCH_RESULTS } from './copilot.code-tools.js';

const REPO = '3f2b8a4e-1c5d-4e7a-9b60-0d1e2f3a4b5c';

function setup() {
    const github = {
        isConfigured: vi.fn().mockReturnValue(true),
        getFileContent: vi.fn().mockResolvedValue({ content: 'hello', sha: 'x' }),
        listDirectory: vi.fn().mockResolvedValue([
            { name: 'a.ts', path: 'src/a.ts', type: 'file' },
            { name: '.env', path: 'src/.env', type: 'file' },
            { name: 'tls.pem', path: 'src/tls.pem', type: 'file' },
        ]),
        searchCode: vi.fn().mockResolvedValue([]),
        getPull: vi.fn(),
        listRecentPulls: vi.fn(),
        listWorkflowRuns: vi.fn(),
    };
    const repos = { getById: vi.fn().mockResolvedValue({ id: REPO, fullName: 'o/r', defaultBranch: 'main' }) };
    const tools = createCodeTools({ repos, github } as never);
    const run = (tool: keyof typeof tools, input: Record<string, unknown>) =>
        (tools[tool].execute as (i: unknown, c: unknown) => Promise<any>)({ repoId: REPO, ...input }, { requestContext: new RequestContext() });
    return { github, repos, run };
}

describe('code tools', () => {
    it('listRepoFiles lists a directory on the default branch and hides secret files', async () => {
        const { github, run } = setup();
        const res = await run('listRepoFiles', { path: '/src/' });
        expect(github.listDirectory).toHaveBeenCalledWith('o/r', 'src', 'main');
        expect(res.entries.map((e: { path: string }) => e.path)).toEqual(['src/a.ts']);
    });

    it('readRepoFile returns content and truncates long files with a note', async () => {
        const { github, run } = setup();
        expect(await run('readRepoFile', { path: 'AGENTS.md' })).toMatchObject({ found: true, content: 'hello', truncated: false });
        github.getFileContent.mockResolvedValue({ content: 'a'.repeat(MAX_FILE_CHARS + 5), sha: 'x' });
        const res = await run('readRepoFile', { path: 'big.txt' });
        expect(res.content).toHaveLength(MAX_FILE_CHARS);
        expect(res.truncated).toBe(true);
        expect(res.note).toContain('Truncated');
    });

    it('readRepoFile reports a missing file', async () => {
        const { github, run } = setup();
        github.getFileContent.mockResolvedValue(null);
        expect(await run('readRepoFile', { path: 'nope.ts' })).toEqual({ found: false, path: 'nope.ts' });
    });

    it('rejects paths with .. segments in every tool', async () => {
        const { github, run } = setup();
        await expect(run('listRepoFiles', { path: 'src/../..' })).rejects.toThrow('..');
        await expect(run('readRepoFile', { path: '../etc/passwd' })).rejects.toThrow('..');
        expect(github.listDirectory).not.toHaveBeenCalled();
        expect(github.getFileContent).not.toHaveBeenCalled();
    });

    it.each(['.env', 'apps/api/.env.local', '.env.example', 'certs/server.pem', 'deploy/private.key'])('refuses secret file %s', async (path) => {
        const { github, run } = setup();
        await expect(run('readRepoFile', { path })).rejects.toThrow('secret');
        expect(github.getFileContent).not.toHaveBeenCalled();
    });

    it('searchRepoCode caps results and drops secret files', async () => {
        const { github, run } = setup();
        github.searchCode.mockResolvedValue([
            { path: '.env', fragments: ['TOKEN=abc'] },
            ...Array.from({ length: 30 }, (_, i) => ({ path: `src/f${i}.ts`, fragments: ['x'] })),
        ]);
        const res = await run('searchRepoCode', { query: 'Foo' });
        expect(github.searchCode).toHaveBeenCalledWith('o/r', 'Foo', MAX_SEARCH_RESULTS);
        expect(res.results).toHaveLength(MAX_SEARCH_RESULTS);
        expect(res.results.some((r: { path: string }) => r.path === '.env')).toBe(false);
    });

    it('fails for unknown repos and when GitHub is not configured, and never writes', async () => {
        const { github, repos, run } = setup();
        repos.getById.mockRejectedValueOnce(new Error('Repo not found'));
        await expect(run('readRepoFile', { path: 'a.ts' })).rejects.toThrow('not found');
        github.isConfigured.mockReturnValue(false);
        await expect(run('listRepoFiles', { path: '' })).rejects.toThrow('GITHUB_TOKEN');
        expect(Object.keys(github).filter((k) => /^(create|update|put|delete|write)/.test(k))).toEqual([]);
    });
});

describe('planning instructions', () => {
    it('forbid asking the user to write the plan and allow at most one question', () => {
        expect(COPILOT_INSTRUCTIONS).toContain('Never ask the user to write');
        expect(COPILOT_INSTRUCTIONS).toContain('at most one question');
        expect(COPILOT_INSTRUCTIONS).toContain('assumptions');
    });

    it('require reading AGENTS.md and files with the code tools before drafting', () => {
        expect(COPILOT_INSTRUCTIONS).toContain('AGENTS.md');
        for (const tool of ['listRepoFiles', 'readRepoFile', 'searchRepoCode']) expect(COPILOT_INSTRUCTIONS).toContain(tool);
    });

    it('contain an example job', () => {
        expect(COPILOT_INSTRUCTIONS).toContain('Example of a good job');
        expect(COPILOT_INSTRUCTIONS).toContain('First run `git fetch origin && git rebase origin/main`');
        expect(COPILOT_INSTRUCTIONS).toContain('must not change');
    });
});
