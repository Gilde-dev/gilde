import { describe, expect, it, vi } from 'vitest';

import type { GitHubPort } from '../github/github.port.js';
import { hashText } from '../run/run-context.js';
import { RepoSkillsReader } from './repo-skills.js';
import { RunContextService } from './run-context.service.js';

const repo = { id: 'r1', fullName: 'o/r', defaultBranch: 'main' };

function setup(over: Partial<GitHubPort> = {}) {
    const files: Record<string, string> = {
        '.claude/skills/.gildeboek-version': 'v1.2.0\n',
        'AGENTS.md': '# agents',
        '.claude/skills/alpha/SKILL.md': '---\nname: alpha\nmanaged-by: gildeboek@v1.2.0\n---\nA\n',
        '.claude/skills/mine/SKILL.md': '---\nname: mine\n---\nM\n',
    };
    const github = {
        isConfigured: () => true,
        getBranchHeadSha: vi.fn().mockResolvedValue('sha1'),
        getFileContent: vi.fn(async (_f: string, path: string) => (path in files ? { content: files[path], sha: 'x' } : null)),
        listDirectory: vi.fn(async (_f: string, path: string) => {
            if (path === '.claude/skills') {
                return [
                    { name: 'alpha', path: '.claude/skills/alpha', type: 'dir' },
                    { name: 'mine', path: '.claude/skills/mine', type: 'dir' },
                    { name: '.gildeboek-version', path: '.claude/skills/.gildeboek-version', type: 'file' },
                ];
            }
            const name = path.split('/').pop()!;
            return [{ name: 'SKILL.md', path: `${path}/SKILL.md`, type: 'file' }].filter(() => `${path}/SKILL.md` in files && name);
        }),
        ...over,
    } as unknown as GitHubPort & { listDirectory: ReturnType<typeof vi.fn>; getBranchHeadSha: ReturnType<typeof vi.fn>; getFileContent: ReturnType<typeof vi.fn> };
    return { github, service: new RunContextService(github, new RepoSkillsReader(github)) };
}

const reads = (github: { listDirectory: unknown }) =>
    (github.listDirectory as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[1] === '.claude/skills').length;

describe('RunContextService', () => {
    it('captures version, skills and the AGENTS.md hash from the default branch', async () => {
        const { service } = setup();
        const out = await service.capture(repo);
        expect(out.contextError).toBeNull();
        expect(out.context?.gildeboekVersion).toBe('v1.2.0');
        expect(out.context?.agentsMdHash).toBe(hashText('# agents'));
        expect(out.context?.skills.map((s) => [s.name, s.managedBy])).toEqual([['alpha', 'gildeboek@v1.2.0'], ['mine', null]]);
    });

    it('reads GitHub once per repo and commit, again when the commit moves', async () => {
        const { service, github } = setup();
        await Promise.all([service.capture(repo), service.capture(repo), service.capture(repo)]);
        await service.capture(repo);
        expect(reads(github)).toBe(1);
        github.getBranchHeadSha.mockResolvedValue('sha2');
        await service.capture(repo);
        expect(reads(github)).toBe(2);
        await service.capture({ ...repo, id: 'r2' });
        expect(reads(github)).toBe(3);
    });

    it('returns context null plus a short error when GitHub fails, and does not cache the failure', async () => {
        const { service, github } = setup();
        github.getBranchHeadSha.mockRejectedValueOnce(new Error(`GitHub GET /repos/o/r/commits/main failed: 500\n${'x'.repeat(500)}`));
        const failed = await service.capture(repo);
        expect(failed.context).toBeNull();
        expect(failed.contextError).toMatch(/^GitHub GET \/repos\/o\/r\/commits\/main failed: 500/);
        expect(failed.contextError!.length).toBeLessThanOrEqual(200);
        expect((await service.capture(repo)).context).not.toBeNull();
    });

    it('does not cache a failed read', async () => {
        const { service, github } = setup();
        github.getFileContent.mockRejectedValueOnce(new Error('boom'));
        expect((await service.capture(repo)).contextError).toBe('boom');
        expect((await service.capture(repo)).context).not.toBeNull();
    });

    it('reports an unconfigured GitHub without calling it', async () => {
        const { service, github } = setup({ isConfigured: () => false });
        expect((await service.capture(repo)).contextError).toBe('GitHub is not configured');
        expect(github.getBranchHeadSha).not.toHaveBeenCalled();
    });
});
