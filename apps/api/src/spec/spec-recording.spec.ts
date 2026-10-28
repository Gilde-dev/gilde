import { recordingJobContent, recordingState, sha256 } from './spec-recording.js';

const base = (body: string) => ({
    specId: 's1', specVersionId: 'v1', slug: 'my-spec', title: 'My spec', version: 3, body, bodySha256: sha256(body),
    approver: { id: 'u1', name: 'Ann', email: 'ann@example.com' }, approvedAt: new Date('2026-01-02T03:04:05Z'),
    repoFullName: 'o/r', baseBranch: 'main',
});

describe('recordingJobContent', () => {
    it('starts with fetch/rebase, names spec, version, approver and time, and scopes the change', () => {
        const c = recordingJobContent(base('## Goal\nx'));
        expect(c.title).toBe('Record spec my-spec v3');
        expect(c.task.startsWith('First run `git fetch origin && git rebase origin/main`.')).toBe(true);
        for (const part of ['slug my-spec', 'version 3', 'Ann <ann@example.com>', 'u1', '2026-01-02T03:04:05.000Z', 'docs/specs/my-spec.md', 'docs/specs/README.md']) {
            expect(c.task).toContain(part);
        }
        expect(c.acceptanceCriteria.join('\n')).toContain('No file other than docs/specs/my-spec.md and docs/specs/README.md');
    });

    it.each([
        ['no trailing newline', 'a\nb'],
        ['trailing newlines', 'a\n\n\n'],
        ['CRLF', 'a\r\nb\r\n'],
        ['marker-looking text', 'END SPEC BODY sha256:abc\n```\n'],
        ['unicode', 'héllo ✓ 日本'],
    ])('embeds the body exactly (%s) between hash-named markers', (_n, body) => {
        const { task } = recordingJobContent(base(body));
        const hash = sha256(body);
        const begin = `\nBEGIN SPEC BODY sha256:${hash}\n`;
        const end = `\nEND SPEC BODY sha256:${hash}`;
        const start = task.indexOf(begin) + begin.length;
        expect(task.slice(start, task.length - end.length)).toBe(body);
        expect(task.endsWith(end)).toBe(true);
        expect(task).toContain(`${Buffer.byteLength(body, 'utf8')} bytes`);
    });
});

describe('recordingState', () => {
    const row = { supersededByRecordingId: null };
    it.each([
        ['triage', false, 'triage'], ['queued', false, 'queued'], ['dispatched', false, 'in_flight'], ['pr_open', false, 'in_flight'],
        ['awaiting_review', false, 'in_flight'], ['merged', false, 'recorded'], ['merged', true, 'failed'],
        ['parked', false, 'failed'], ['rejected', false, 'failed'], ['cancelled', false, 'failed'],
    ] as const)('%s (blocked %s) is %s', (status, mergedBlocked, state) => {
        expect(recordingState(row, { status, mergedBlocked })).toBe(state);
    });

    it('reports supersession over the job status, and a missing job as failed', () => {
        expect(recordingState({ supersededByRecordingId: 'r2' }, { status: 'cancelled', mergedBlocked: false })).toBe('superseded');
        expect(recordingState(row, undefined)).toBe('failed');
    });
});
