import { RequestContext } from '@mastra/core/request-context';

import { COPILOT_INSTRUCTIONS } from './copilot.instructions.js';
import { createCodeTools, MAX_FILE_CHARS } from './copilot.code-tools.js';

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
        getPull: vi.fn(),
        listRecentPulls: vi.fn(),
        listWorkflowRuns: vi.fn(),
    };
    const repos = { getById: vi.fn().mockResolvedValue({ id: REPO, fullName: 'o/r', defaultBranch: 'main' }) };
    // Default: no usable clone, so the GitHub port is used.
    const workspace = {
        ensure: vi.fn().mockResolvedValue(null),
        status: vi.fn().mockReturnValue({ cloned: false, headSha: null, fetchedAt: null, error: 'clone failed' }),
        listDirectory: vi.fn(),
        readFile: vi.fn(),
        grep: vi.fn(),
    };
    const tools = createCodeTools({ repos, github, workspace } as never);
    const run = (tool: keyof typeof tools, input: Record<string, unknown>) =>
        (tools[tool].execute as (i: unknown, c: unknown) => Promise<any>)({ repoId: REPO, ...input }, { requestContext: new RequestContext() });
    return { github, repos, workspace, run };
}

describe('code tools', () => {
    it('listRepoFiles lists a directory on the default branch and hides secret files', async () => {
        const { github, run } = setup();
        const res = await run('listRepoFiles', { path: 'src/' });
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

    it('limits whole-file reads to 12000 characters and reports the total line count', async () => {
        const { github, run } = setup();
        expect(MAX_FILE_CHARS).toBe(12_000);
        github.getFileContent.mockResolvedValue({ content: 'line\n'.repeat(5000), sha: 'x' });
        const res = await run('readRepoFile', { path: 'big.txt' });
        expect(res.content).toHaveLength(12_000);
        expect(res.totalLines).toBe(5001);
        expect(res.note).toContain('5001 lines');
    });

    it('readRepoFile reads a line range', async () => {
        const { github, run } = setup();
        github.getFileContent.mockResolvedValue({ content: 'a\nb\nc\nd\ne', sha: 'x' });
        expect(await run('readRepoFile', { path: 'f.ts', startLine: 2, endLine: 4 })).toMatchObject({ content: 'b\nc\nd', startLine: 2, endLine: 4, totalLines: 5, truncated: false });
        expect(await run('readRepoFile', { path: 'f.ts', startLine: 4 })).toMatchObject({ content: 'd\ne', endLine: 5 });
        await expect(run('readRepoFile', { path: 'f.ts', startLine: 9 })).rejects.toThrow('Invalid line range');
    });

    it('searchRepoCode greps the local clone', async () => {
        const { workspace, run } = setup();
        workspace.ensure.mockResolvedValue('/clone');
        workspace.grep.mockResolvedValue({ matches: [{ path: 'src/a.ts', line: 2, text: 'foo', context: [] }], truncated: false });
        const res = await run('searchRepoCode', { query: 'foo', regex: true, path: '/src/'.slice(1) });
        expect(workspace.grep).toHaveBeenCalledWith('/clone', { query: 'foo', regex: true, path: 'src' });
        expect(res.matches).toHaveLength(1);
    });

    it('searchRepoCode returns a clear error without a clone', async () => {
        const { run } = setup();
        await expect(run('searchRepoCode', { query: 'foo' })).rejects.toThrow(/Code search is unavailable.*clone failed/);
    });

    it('listRepoFiles and readRepoFile use the clone when there is one', async () => {
        const { github, workspace, run } = setup();
        workspace.ensure.mockResolvedValue('/clone');
        workspace.listDirectory.mockResolvedValue([{ name: 'a.ts', path: 'src/a.ts', type: 'file' }]);
        workspace.readFile.mockResolvedValue('a\nb\nc');
        expect((await run('listRepoFiles', { path: 'src' })).entries).toHaveLength(1);
        expect(await run('readRepoFile', { path: 'src/a.ts', startLine: 2, endLine: 3 })).toMatchObject({ content: 'b\nc' });
        expect(github.listDirectory).not.toHaveBeenCalled();
        expect(github.getFileContent).not.toHaveBeenCalled();
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
        await expect(run('readRepoFile', { path: '/etc/passwd' })).rejects.toThrow('Absolute');
        await expect(run('searchRepoCode', { query: 'x', path: '../x' })).rejects.toThrow('..');
        expect(github.listDirectory).not.toHaveBeenCalled();
        expect(github.getFileContent).not.toHaveBeenCalled();
    });

    it.each(['.env', 'apps/api/.env.local', '.env.example', 'certs/server.pem', 'deploy/private.key'])('refuses secret file %s', async (path) => {
        const { github, run } = setup();
        await expect(run('readRepoFile', { path })).rejects.toThrow('secret');
        expect(github.getFileContent).not.toHaveBeenCalled();
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

    it('require adherence to named technologies, tests in every job and a step budget', () => {
        expect(COPILOT_INSTRUCTIONS).toContain('exactly the technologies, frameworks and approaches the user names');
        expect(COPILOT_INSTRUCTIONS).toContain('built-in features of the frameworks already in the repo');
        expect(COPILOT_INSTRUCTIONS).toContain('Every job includes its own tests and doc updates');
        expect(COPILOT_INSTRUCTIONS).toContain('Never create a separate tests-only or docs-only job');
        expect(COPILOT_INSTRUCTIONS).toContain('Budget your steps');
        expect(COPILOT_INSTRUCTIONS).toContain('planFeature by about step 15');
    });

    it('contain an example job', () => {
        expect(COPILOT_INSTRUCTIONS).toContain('Example of a good job');
        expect(COPILOT_INSTRUCTIONS).toContain('First run `git fetch origin && git rebase origin/main`');
        expect(COPILOT_INSTRUCTIONS).toContain('must not change');
    });
});
