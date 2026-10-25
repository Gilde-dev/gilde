import { describe, expect, it } from 'vitest';

import { computeDrift, countStatuses, RepoSkillsReader, type RepoSkill } from './repo-skills.js';
import type { CatalogSkill } from './skill-library.js';
import type { GitHubPort } from '../github/github.port.js';

const lib = (name: string, extra: { path: string; content: string }[] = []): CatalogSkill => ({
    name,
    description: `${name} desc`,
    scope: 'global',
    stacks: [],
    files: [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${name} desc\n---\nBody\n` }, ...extra],
});

const managed = (name: string, over: Partial<RepoSkill> = {}): RepoSkill => ({
    name,
    description: `${name} desc`,
    source: 'managed',
    managedBy: 'lib@1',
    files: [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${name} desc\nmanaged-by: lib@1\n---\nBody\n` }],
    ...over,
});

const own = (name: string): RepoSkill => ({
    name,
    description: 'mine',
    source: 'repo',
    managedBy: null,
    files: [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: mine\n---\n` }],
});

const statusOf = (desired: string[], catalog: CatalogSkill[], present: RepoSkill[]) =>
    Object.fromEntries(computeDrift(desired, catalog, present).map((d) => [d.name, d.status]));

describe('computeDrift', () => {
    it('ok: managed and equal apart from the managed-by line', () => {
        expect(statusOf(['a'], [lib('a')], [managed('a')])).toEqual({ a: 'ok' });
    });

    it('ok also when other files match byte for byte', () => {
        const extra = [{ path: 'x.sh', content: 'echo\n' }];
        const have = managed('a');
        have.files.push(...extra);
        expect(statusOf(['a'], [lib('a', extra)], [have])).toEqual({ a: 'ok' });
    });

    it('outdated: SKILL.md body differs', () => {
        const have = managed('a');
        have.files[0].content = have.files[0].content.replace('Body', 'Old body');
        expect(statusOf(['a'], [lib('a')], [have])).toEqual({ a: 'outdated' });
    });

    it('outdated: another file differs or is missing', () => {
        const extra = [{ path: 'x.sh', content: 'echo\n' }];
        expect(statusOf(['a'], [lib('a', extra)], [managed('a')])).toEqual({ a: 'outdated' });
        const have = managed('a');
        have.files.push({ path: 'x.sh', content: 'echo \n' });
        expect(statusOf(['a'], [lib('a', extra)], [have])).toEqual({ a: 'outdated' });
    });

    it('outdated: the repo has an extra file', () => {
        const have = managed('a');
        have.files.push({ path: 'extra.md', content: '' });
        expect(statusOf(['a'], [lib('a')], [have])).toEqual({ a: 'outdated' });
    });

    it('missing: desired and not present', () => {
        expect(statusOf(['a'], [lib('a')], [])).toEqual({ a: 'missing' });
    });

    it('orphaned: managed but not desired', () => {
        expect(statusOf([], [lib('a')], [managed('a')])).toEqual({ a: 'orphaned' });
        expect(statusOf([], [], [managed('gone')])).toEqual({ gone: 'orphaned' });
    });

    it('conflict: repo skill with the name of a desired library skill', () => {
        expect(statusOf(['a'], [lib('a')], [own('a')])).toEqual({ a: 'conflict' });
    });

    it('repo: repo-owned and not desired', () => {
        expect(statusOf(['a'], [lib('a')], [own('mine')])).toEqual({ a: 'missing', mine: 'repo' });
        expect(statusOf([], [lib('a')], [own('a')])).toEqual({ a: 'repo' });
    });

    it('counts per status', () => {
        const drift = computeDrift(['a', 'b'], [lib('a'), lib('b')], [managed('a'), own('x')]);
        expect(countStatuses(drift)).toEqual({ ok: 1, outdated: 0, missing: 1, orphaned: 0, conflict: 0, repo: 1 });
    });
});

describe('RepoSkillsReader', () => {
    const files: Record<string, string> = {
        '.claude/skills/m/SKILL.md': '---\nname: m\ndescription: M\nmanaged-by: whatever@abc\n---\n',
        '.claude/skills/m/scripts/a.sh': 'a',
        '.claude/skills/r/SKILL.md': '---\nname: r\ndescription: R\n---\n',
        '.claude/skills/README.md': 'not a skill',
    };
    const github = {
        listDirectory: async (_f: string, path: string) => {
            const prefix = `${path}/`;
            const names = new Map<string, 'file' | 'dir'>();
            for (const p of Object.keys(files)) {
                if (!p.startsWith(prefix)) continue;
                const rest = p.slice(prefix.length);
                names.set(rest.split('/')[0], rest.includes('/') ? 'dir' : 'file');
            }
            return names.size ? [...names].map(([name, type]) => ({ name, path: prefix + name, type })) : null;
        },
        getFileContent: async (_f: string, path: string) => (path in files ? { content: files[path], sha: 'x' } : null),
    } as unknown as GitHubPort;

    it('classifies managed and repo skills and keeps managed-by opaque', async () => {
        const skills = await new RepoSkillsReader(github).read({ id: 'r', fullName: 'o/r', defaultBranch: 'main' });
        expect(skills.map((s) => [s.name, s.source, s.managedBy, s.description])).toEqual([
            ['m', 'managed', 'whatever@abc', 'M'],
            ['r', 'repo', null, 'R'],
        ]);
        expect(skills[0].files.map((f) => f.path)).toEqual(['SKILL.md', 'scripts/a.sh']);
    });

    it('returns nothing when the folder does not exist', async () => {
        const empty = { listDirectory: async () => null } as unknown as GitHubPort;
        expect(await new RepoSkillsReader(empty).read({ id: 'r', fullName: 'o/r', defaultBranch: 'main' })).toEqual([]);
    });

    it('caches per repo for 5 minutes', async () => {
        let calls = 0;
        const counting = { ...github, listDirectory: (...a: Parameters<GitHubPort['listDirectory']>) => (calls++, github.listDirectory(...a)) } as GitHubPort;
        let now = 0;
        const reader = new RepoSkillsReader(counting, () => now);
        const repo = { id: 'r', fullName: 'o/r', defaultBranch: 'main' };
        await reader.read(repo);
        const first = calls;
        now = 299_000;
        await reader.read(repo);
        expect(calls).toBe(first);
        reader.invalidate('r');
        await reader.read(repo);
        expect(calls).toBeGreaterThan(first);
    });
});
