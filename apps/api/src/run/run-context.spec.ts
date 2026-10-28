import { describe, expect, it } from 'vitest';

import type { RepoSkill } from '../skill/repo-skills.js';
import { buildRunContext, hashSkillFiles, hashText } from './run-context.js';

const files = [
    { path: 'SKILL.md', content: '---\nname: a\n---\nBody\n' },
    { path: 'scripts/run.sh', content: 'echo\n' },
];

const skill = (name: string, over: Partial<RepoSkill> = {}): RepoSkill => ({
    name, description: null, source: 'repo', managedBy: null, files, ...over,
});

describe('hashSkillFiles', () => {
    it('is stable and independent of the listing order', () => {
        expect(hashSkillFiles(files)).toBe(hashSkillFiles([...files].reverse()));
        expect(hashSkillFiles(files)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('changes with content or path', () => {
        const base = hashSkillFiles(files);
        expect(hashSkillFiles([{ ...files[0], content: 'x' }, files[1]])).not.toBe(base);
        expect(hashSkillFiles([{ ...files[0], path: 'OTHER.md' }, files[1]])).not.toBe(base);
    });

    it('does not confuse where one file ends and the next begins', () => {
        const a = hashSkillFiles([{ path: 'a', content: 'bc' }, { path: 'd', content: '' }]);
        const b = hashSkillFiles([{ path: 'a', content: 'b' }, { path: 'cd', content: '' }]);
        expect(a).not.toBe(b);
    });
});

describe('buildRunContext', () => {
    it('lists skills by name with hash and managedBy, and hashes AGENTS.md', () => {
        const ctx = buildRunContext({
            skills: [skill('zeta', { managedBy: 'gildeboek@v1', source: 'managed' }), skill('alpha')],
            gildeboekVersion: 'v1',
            agentsMd: '# agents',
            capturedAt: new Date('2026-01-01T00:00:00Z'),
        });
        expect(ctx.skills.map((s) => [s.name, s.managedBy])).toEqual([['alpha', null], ['zeta', 'gildeboek@v1']]);
        expect(ctx.skills[0].hash).toBe(hashSkillFiles(files));
        expect(ctx.agentsMdHash).toBe(hashText('# agents'));
        expect(ctx.gildeboekVersion).toBe('v1');
        expect(ctx.capturedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('uses null for a missing AGENTS.md', () => {
        const ctx = buildRunContext({ skills: [], gildeboekVersion: null, agentsMd: null, capturedAt: new Date() });
        expect(ctx.agentsMdHash).toBeNull();
        expect(ctx.gildeboekVersion).toBeNull();
    });
});
