import type { LessonPatternDto } from './lesson.dto.js';
import { proposalCriteria, proposalTask, proposalTitle, redactSecrets } from './lesson-skill-proposal.js';

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const J1 = '33333333-3333-4333-8333-333333333333';
const J2 = '44444444-4444-4444-8444-444444444444';
const PROJECT = '55555555-5555-4555-8555-555555555555';
const REPO = '66666666-6666-4666-8666-666666666666';

const source = (jobId: string, prUrl: string | null) =>
    ({ id: jobId, kind: 'suggested_lesson' as const, jobId, runId: null, feedbackId: null, excerpt: 'EXCERPT-not-included', prUrl, createdAt: '2026-01-01T00:00:00.000Z' });

const pattern = (over: Partial<LessonPatternDto> = {}): LessonPatternDto => ({
    id: 'p', representativeText: 'Run pnpm install first', size: 2,
    members: [
        { lessonId: L1, text: 'Run pnpm install first', status: 'candidate', sources: [source(J1, 'https://github.com/o/a/pull/1')] },
        { lessonId: L2, text: 'Always run `pnpm install` first!', status: 'approved', sources: [source(J2, null)] },
    ],
    jobIds: [J1, J2], runIds: [], repoIds: [REPO], firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-02T00:00:00.000Z', alreadyCovered: [], ...over,
});

const ctx = { projectId: PROJECT, repoNames: new Map([[REPO, 'o/a']]), taken: ['existing-skill'], testCommands: ['pnpm validate'], prUrls: new Map() };

describe('proposalTask', () => {
    it('names the skill and scope, quotes every member lesson verbatim with job and PR links, and asks for a registered, validated SKILL.md', () => {
        const task = proposalTask(pattern(), { name: 'pnpm-install', scope: 'stack', stacks: ['nestjs'] }, ctx);
        expect(task).toContain("'pnpm-install'");
        expect(task).toContain('scope stack, stacks [nestjs]');
        expect(task).toContain(`Lesson ${L1}: "Run pnpm install first"`);
        expect(task).toContain('"Always run `pnpm install` first!"');
        expect(task).toContain(`/?project=${PROJECT}&job=${J1} (https://github.com/o/a/pull/1)`);
        expect(task).toContain(`job=${J2}`);
        expect(task).toContain('o/a');
        expect(task).toContain('skills/pnpm-install/SKILL.md');
        expect(task).toContain('registry.yaml');
        expect(task).toContain('`pnpm validate`');
        expect(task).toContain('existing-skill');
        expect(task).not.toContain('EXCERPT-not-included');
    });

    it('says global scope and falls back to AGENTS.md validation without test commands', () => {
        const task = proposalTask(pattern(), { name: 'x-skill', scope: 'global' }, { ...ctx, testCommands: [], taken: [] });
        expect(task).toContain('scope global');
        expect(task).toContain('AGENTS.md');
    });

    it('never includes secrets and bounds long lessons', () => {
        const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
        const long = `${'x'.repeat(5000)}`;
        const p = pattern({ representativeText: `token ${secret}`, members: [{ lessonId: L1, text: `use Bearer abcdefghijklmnopqrstuvwxyz123456 and gk_abc_secretvalue ${long}`, status: 'candidate', sources: [] }] });
        const task = proposalTask(p, { name: 'x-skill', scope: 'global' }, ctx);
        expect(task).not.toContain(secret);
        expect(task).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
        expect(task).not.toContain('gk_abc_secretvalue');
        expect(task).toContain('[redacted]');
        expect(task.length).toBeLessThan(6000);
    });

    it('lists at most 30 members and says so', () => {
        const members = Array.from({ length: 40 }, (_, i) => ({ lessonId: `${i}`, text: `lesson ${i}`, status: 'candidate' as const, sources: [] }));
        const task = proposalTask(pattern({ members, size: 40 }), { name: 'x-skill', scope: 'global' }, ctx);
        expect(task).toContain('30 of 40');
        expect(task).not.toContain('Lesson 30:');
    });
});

describe('proposal title and criteria', () => {
    it('uses the given title or a default, and states scope and stacks in the criteria', () => {
        expect(proposalTitle({ name: 'a-skill', scope: 'global' })).toBe('Add skill a-skill to the skills library');
        expect(proposalTitle({ name: 'a-skill', scope: 'global', title: 'My title' })).toBe('My title');
        expect(proposalCriteria({ name: 'a-skill', scope: 'stack', stacks: ['nextjs', 'nestjs'] }).join('\n')).toContain('scope stack and stacks nextjs, nestjs');
    });
});

describe('redactSecrets', () => {
    it('masks api keys, tokens and private keys', () => {
        const text = 'gk_ab12_cdef sk-abcdefghijklmnopqrstuvwx xoxb-1234567890-abc -----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY----- ok';
        expect(redactSecrets(text)).toBe('[redacted] [redacted] [redacted] [redacted] ok');
    });
});
