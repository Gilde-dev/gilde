import { DOWNSTREAM_LIMIT } from './downstream.js';
import type { JobPayload } from './execution.port.js';
import { PROMPT_LIMIT, TRUNCATED_SUFFIX, prepareJobPrompt, promptTooLargeError } from './job-prompt.js';

const base: JobPayload = {
    gilde: 1, jobId: 'job-1', runId: 'run-1', attempt: 1, repo: 'o/r', baseBranch: 'main',
    title: 'T', task: 'Do it', acceptanceCriteria: ['works'], testCommands: ['pnpm test'], stacks: [],
};
const lesson = (i: number, size = 100) => ({ id: `l${i}`, text: 'z'.repeat(size), scope: 'project' as const, status: 'approved' as const, relevance: 0.9 - i / 100 });
const down = (id: string, taskSize: number, dependsOn: string[] = []) => ({ jobId: id, title: `D ${id}`, task: 't'.repeat(taskSize), acceptanceCriteria: [`c-${id}`], dependsOn });
const none = { text: null, version: null };
/** Length of the job line plus payload, without instructions. */
const jobLength = (p: JobPayload) =>
    `Gilde job ${p.jobId} (attempt ${p.attempt}). Execute it as described in your routine instructions.\n\n`.length + JSON.stringify(p).length;

/** Instructions sized so that rendering `target` is exactly `slack` characters under the limit (negative: over). */
const fitting = (target: JobPayload, slack = 0) => ({ text: 'x'.repeat(PROMPT_LIMIT - '\n\n---\n\n'.length - jobLength(target) - slack), version: 'v' });

const capped = (list: ReturnType<typeof down>[], cap: number) =>
    list.map((d) => (d.task.length > cap ? { ...d, task: d.task.slice(0, cap - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX } : d));
const titleOnly = (list: ReturnType<typeof down>[]) => list.map(({ task: _task, ...d }) => d);

describe('prepareJobPrompt', () => {
    it('renders an untrimmed prompt exactly as before and does not mutate the payload', () => {
        const payload = { ...base, lessons: [lesson(1)], downstream: [down('d1', 50)] };
        const copy = structuredClone(payload);
        const prepared = prepareJobPrompt(payload, { text: 'Be good.\n', version: 'v1' });
        expect(prepared.text).toBe(`Be good.\n\n---\n\nGilde job job-1 (attempt 1). Execute it as described in your routine instructions.\n\n${JSON.stringify(payload)}`);
        expect(prepared).toMatchObject({ length: prepared.text.length, limit: PROMPT_LIMIT, fits: true, trimmed: null, instructionsVersion: 'v1', instructionsLength: 8 });
        expect(prepared.payload).toEqual(payload);
        expect(payload).toEqual(copy);
    });

    it('drops lessons one at a time from the least relevant end and stops as soon as it fits', () => {
        const downstream = [down('d1', 3000)];
        const payload: JobPayload = { ...base, lessons: [1, 2, 3, 4].map((i) => lesson(i, 400)), downstream };
        const target: JobPayload = { ...payload, lessons: payload.lessons!.slice(0, 3), promptTrimmed: { lessonsRemoved: ['l4'] } };
        const prepared = prepareJobPrompt(payload, fitting(target));
        expect(prepared.fits).toBe(true);
        expect(prepared.length).toBe(PROMPT_LIMIT);
        expect(prepared.trimmed).toEqual({ lessonsRemoved: ['l4'] });
        expect(prepared.payload).toEqual(target);
        expect(prepared.payload.downstream?.[0].task).toHaveLength(3000);
    });

    it('applies 1500, then 400, then omits task keys keeping jobId, title, criteria and dependsOn, after lessons', () => {
        const downstream = [down('d1', 3000, ['job-1']), down('d2', 3000)];
        const payload: JobPayload = { ...base, lessons: [lesson(1, 50)], downstream };
        const targetFor = (list: unknown, cap: number | 'title-only'): JobPayload => ({
            ...base, downstream: list as never, promptTrimmed: { lessonsRemoved: ['l1'], downstreamTaskCap: cap },
        });

        const a = prepareJobPrompt(payload, fitting(targetFor(capped(downstream, 1500), 1500)));
        expect(a.trimmed).toEqual({ lessonsRemoved: ['l1'], downstreamTaskCap: 1500 });
        expect(a.payload.downstream?.map((d) => d.task?.length)).toEqual([1500, 1500]);
        expect(a.payload.downstream?.[0].task?.endsWith(TRUNCATED_SUFFIX)).toBe(true);
        expect(a.length).toBe(PROMPT_LIMIT);

        const b = prepareJobPrompt(payload, fitting(targetFor(capped(downstream, 400), 400)));
        expect(b.trimmed).toEqual({ lessonsRemoved: ['l1'], downstreamTaskCap: 400 });
        expect(b.payload.downstream?.map((d) => d.task?.length)).toEqual([400, 400]);

        const c = prepareJobPrompt(payload, fitting(targetFor(titleOnly(downstream), 'title-only')));
        expect(c.trimmed).toEqual({ lessonsRemoved: ['l1'], downstreamTaskCap: 'title-only' });
        expect(c.payload.downstream).toEqual([
            { jobId: 'd1', title: 'D d1', acceptanceCriteria: ['c-d1'], dependsOn: ['job-1'] },
            { jobId: 'd2', title: 'D d2', acceptanceCriteria: ['c-d2'], dependsOn: [] },
        ]);
        expect(JSON.stringify(c.payload.downstream)).not.toContain('"task"');
        expect(c.fits).toBe(true);
    });

    it('does not add the suffix to a task that fits the cap, and does not report a cap that cut nothing', () => {
        const downstream = [down('short', 100), down('long', 5000)];
        const payload: JobPayload = { ...base, downstream };
        const target: JobPayload = { ...base, downstream: capped(downstream, 1500), promptTrimmed: { downstreamTaskCap: 1500 } };
        const prepared = prepareJobPrompt(payload, fitting(target));
        expect(prepared.payload.downstream?.[0].task).toBe('t'.repeat(100));
        expect(prepared.payload.downstream?.[1].task).toHaveLength(1500);

        const small: JobPayload = { ...base, downstream: [down('only', 300)] };
        // Needs one character more than the untrimmed form has: caps 1500 and 400 would cut nothing, so only the task-less form is reported.
        const tight = prepareJobPrompt(small, fitting(small, -1));
        expect(tight.trimmed).toEqual({ downstreamTaskCap: 'title-only' });
        expect(tight.payload.downstream?.[0]).not.toHaveProperty('task');
    });

    it('removes unrelated feature siblings (oldest first) before transitive dependents (oldest first)', () => {
        const downstream = [down('dep-old', 10), down('sib-old', 10), down('dep-new', 10), down('sib-new', 10)];
        const dependents = new Set(['dep-old', 'dep-new']);
        const payload: JobPayload = { ...base, downstream };
        const run = (removed: string[]) => {
            const kept = titleOnly(downstream.filter((d) => !removed.includes(d.jobId)));
            const target: JobPayload = { ...base, ...(kept.length ? { downstream: kept as never } : {}), promptTrimmed: { downstreamTaskCap: 'title-only', downstreamRemoved: downstream.map((d) => d.jobId).filter((i) => removed.includes(i)) } };
            return prepareJobPrompt(payload, fitting(target), { dependents });
        };

        expect(run(['sib-old']).trimmed?.downstreamRemoved).toEqual(['sib-old']);
        expect(run(['sib-old', 'sib-new']).trimmed?.downstreamRemoved).toEqual(['sib-old', 'sib-new']);
        const third = run(['dep-old', 'sib-old', 'sib-new']);
        expect(third.trimmed?.downstreamRemoved).toEqual(['dep-old', 'sib-old', 'sib-new']);
        expect(third.payload.downstream?.map((d) => d.jobId)).toEqual(['dep-new']);
        const all = run(['dep-old', 'sib-old', 'dep-new', 'sib-new']);
        expect(all.payload).not.toHaveProperty('downstream');
        expect(all.trimmed?.downstreamRemoved).toEqual(['dep-old', 'sib-old', 'dep-new', 'sib-new']);
        expect(all.fits).toBe(true);
    });

    it('keeps a dependent that is among a full list of 20 while siblings are removed first', () => {
        const downstream = [down('dep', 10), ...Array.from({ length: DOWNSTREAM_LIMIT - 1 }, (_, i) => down(`sib${String(i).padStart(2, '0')}`, 10))];
        const payload: JobPayload = { ...base, downstream };
        const removedSiblings = downstream.slice(1, 10).map((d) => d.jobId);
        const target: JobPayload = {
            ...base, downstream: titleOnly(downstream.filter((d) => !removedSiblings.includes(d.jobId))) as never,
            promptTrimmed: { downstreamTaskCap: 'title-only', downstreamRemoved: removedSiblings },
        };
        const prepared = prepareJobPrompt(payload, fitting(target), { dependents: new Set(['dep']) });
        expect(prepared.trimmed?.downstreamRemoved).toEqual(removedSiblings);
        expect(prepared.payload.downstream?.map((d) => d.jobId)).toContain('dep');
    });

    it('caps the feature spec at 4000 then 2000 only after all downstream reductions', () => {
        const downstream = [down('d1', 100)];
        const payload: JobPayload = { ...base, feature: { title: 'F', spec: 's'.repeat(8000), acceptanceCriteria: ['f'] }, downstream };
        const target = (spec: number): JobPayload => ({
            ...base, feature: { title: 'F', spec: 's'.repeat(spec), acceptanceCriteria: ['f'] },
            promptTrimmed: { downstreamTaskCap: 'title-only', downstreamRemoved: ['d1'], featureSpecCap: spec },
        });
        const at4000 = prepareJobPrompt(payload, fitting(target(4000)));
        expect(at4000.trimmed).toEqual({ downstreamTaskCap: 'title-only', downstreamRemoved: ['d1'], featureSpecCap: 4000 });
        expect(at4000.payload.feature?.spec).toHaveLength(4000);
        const at2000 = prepareJobPrompt(payload, fitting(target(2000)));
        expect(at2000.trimmed?.featureSpecCap).toBe(2000);
        expect(at2000.payload.feature?.spec).toHaveLength(2000);
        expect(at2000.fits).toBe(true);
    });

    it('records initial caps from context construction and omits promptTrimmed when nothing was trimmed', () => {
        const payload: JobPayload = { ...base, feature: { title: 'F', spec: 'short', acceptanceCriteria: [] } };
        expect(prepareJobPrompt(payload, none).payload).not.toHaveProperty('promptTrimmed');
        const prepared = prepareJobPrompt(payload, none, { initial: { downstreamTaskCap: 4000, downstreamOmitted: 3, featureSpecCap: 8000 } });
        expect(prepared.trimmed).toEqual({ downstreamTaskCap: 4000, downstreamOmitted: 3, featureSpecCap: 8000 });
        expect(prepared.text.endsWith('"promptTrimmed":{"downstreamTaskCap":4000,"downstreamOmitted":3,"featureSpecCap":8000}}')).toBe(true);
    });

    it('measures the exact final text: metadata overhead, JSON escaping and UTF-16 characters', () => {
        const nasty: JobPayload = { ...base, task: 'quote " backslash \\ newline \n emoji 😀 tab \t', lessons: [lesson(1, 10)] };
        const { lessons: _l, ...rest } = nasty;
        const trimmedForm: JobPayload = { ...rest, promptTrimmed: { lessonsRemoved: ['l1'] } };
        const fits = prepareJobPrompt(nasty, fitting(trimmedForm));
        expect(fits.fits).toBe(true);
        expect(fits.length).toBe(PROMPT_LIMIT);
        expect(fits.text).toContain('"promptTrimmed":{"lessonsRemoved":["l1"]}');
        // One character less room and the metadata makes the trimmed form too long.
        const over = prepareJobPrompt(nasty, fitting(trimmedForm, -1));
        expect(over.fits).toBe(false);
        expect(over.length).toBe(PROMPT_LIMIT + 1);
        expect(over.text).toContain('quote \\" backslash \\\\ newline \\n emoji 😀 tab \\t');
    });

    it('never shortens instructions, task or criteria; irreducible overflow is returned, then reported as a job-scoped error', () => {
        const payload: JobPayload = { ...base, task: 'T'.repeat(30_000), acceptanceCriteria: ['c'.repeat(500)], downstream: [down('d1', 100)], lessons: [lesson(1)] };
        const instructions = { text: 'I'.repeat(40_000), version: 'v' };
        const prepared = prepareJobPrompt(payload, instructions);
        expect(prepared.fits).toBe(false);
        expect(prepared.payload.task).toBe(payload.task);
        expect(prepared.payload.acceptanceCriteria).toEqual(payload.acceptanceCriteria);
        expect(prepared.text.startsWith('I'.repeat(40_000))).toBe(true);
        expect(prepared.trimmed).toEqual({ lessonsRemoved: ['l1'], downstreamTaskCap: 'title-only', downstreamRemoved: ['d1'] });
        expect(prepared.ownLength).toBe(30_500);
        expect(prepared.instructionsLength).toBe(40_000);

        const err = promptTooLargeError(prepared, 'job-1');
        expect(err.kind).toBe('prompt_too_large');
        expect(err.retryable).toBe(false);
        expect(err.message).toBe(`Prompt for job job-1 is ${String(prepared.length).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} characters after trimming, over the 60 000 limit; the task and criteria alone are 30 500, the agent instructions take 40 000: shorten the task or its acceptance criteria`);
    });

    it('mentions the instructions only when they explain the overflow', () => {
        const small = prepareJobPrompt({ ...base, task: 'T'.repeat(61_000) }, { text: 'I'.repeat(5), version: 'v' });
        expect(promptTooLargeError(small, 'j').message).not.toContain('instructions');
        const big = prepareJobPrompt(base, { text: 'I'.repeat(60_000), version: 'v' });
        expect(promptTooLargeError(big, 'j').message).toContain('the agent instructions take 60 000');
    });
});
