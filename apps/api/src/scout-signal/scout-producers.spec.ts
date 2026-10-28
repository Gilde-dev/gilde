import { DataSource } from 'typeorm';

import { Feature } from '../feature/feature.entity.js';
import { FeatureMapper } from '../feature/feature.mapper.js';
import { FeatureService } from '../feature/feature.service.js';
import { Feedback } from '../feedback/feedback.entity.js';
import { FeedbackMapper } from '../feedback/feedback.mapper.js';
import { FeedbackService, type NewFeedback } from '../feedback/feedback.service.js';
import { JobEventsService } from '../job/job-events.service.js';
import { Job } from '../job/job.entity.js';
import { Lesson } from '../lesson/lesson.entity.js';
import { LessonSource } from '../lesson/lesson-source.entity.js';
import { LessonCollectorService } from '../lesson/lesson-collector.service.js';
import { J1, P1, addRun, memoryDb } from '../lesson/lesson.fixture.js';
import { NotificationCaptureService } from '../notification/notification-capture.service.js';
import { Project } from '../project/project.entity.js';
import { JobRun } from '../run/run.entity.js';
import { User } from '../user/user.entity.js';
import { parsePrBody } from '../webhook/pr-body.js';
import type { ScoutEvent } from './scout-signal.events.js';
import { ScoutSignalPublisher } from './scout-signal.publisher.js';

const REPO = '33333333-3333-4333-8333-333333333333';
const RUN_BODY = (outcome: string, extra = '') =>
    `gilde-job: ${J1}\ngilde-run: RUNID\n\n\`\`\`gilde-result\n{"outcome":"${outcome}","summary":"s${extra}"}\n\`\`\`\n`;

/** A publisher with a recording sink, as the real service would register. */
function recorder() {
    const publisher = new ScoutSignalPublisher();
    const sent: Array<{ projectId: string; event: ScoutEvent }> = [];
    publisher.register(async (projectId, event) => { sent.push({ projectId, event }); });
    return { publisher, sent };
}

describe('run outcome events (JobEventsService.recordProposals, the shared post-persistence hook)', () => {
    let ds: DataSource;
    let sent: ReturnType<typeof recorder>['sent'];
    let events: JobEventsService;
    let job: Job;

    const parsed = (outcome: string, extra = '', runId = 'x') => parsePrBody(RUN_BODY(outcome, extra).replace('RUNID', runId));
    const freshRun = async (over: Partial<JobRun> = {}) => addRun(ds, { status: 'fired', ...over });

    beforeEach(async () => {
        ds = await memoryDb();
        const r = recorder();
        sent = r.sent;
        await ds.getRepository(Project).save({ id: P1, slug: 's', name: 'n', maxAttempts: 2 } as Partial<Project>);
        job = await ds.getRepository(Job).save({ id: J1, projectId: P1, repoId: REPO, title: 't', task: 't', queuedAt: new Date(), status: 'dispatched' });
        events = new JobEventsService(ds.getRepository(Job), ds.getRepository(JobRun), ds.getRepository(Project), undefined, undefined, undefined, undefined, r.publisher);
    });
    afterEach(() => ds.destroy());

    it('notifies blocked and partial results that are stored, without proposal collection', async () => {
        for (const outcome of ['blocked', 'partial'] as const) {
            const run = await freshRun();
            const p = parsed(outcome);
            await ds.getRepository(JobRun).update({ id: run.id }, { result: p.result, resultError: p.resultError, retro: p.retro });
            await events.recordProposals(job, run, p); // no ProposalService: proposals are disabled
            expect(sent.at(-1)).toEqual({ projectId: P1, event: { type: 'run_outcome', outcome, jobId: J1, runId: run.id, repoId: REPO } });
        }
        expect(sent).toHaveLength(2);
    });

    it('does not notify a done result', async () => {
        const run = await freshRun();
        const p = parsed('done');
        await ds.getRepository(JobRun).update({ id: run.id }, { result: p.result });
        await events.recordProposals(job, run, p);
        expect(sent).toHaveLength(0);
    });

    it('does not notify an outcome that was not stored (a conditional update that did not apply, or an unparsable body)', async () => {
        const run = await freshRun({ result: null }); // nothing stored for this parse
        await events.recordProposals(job, run, parsed('blocked'));
        expect(sent).toHaveLength(0);

        const other = await freshRun({ result: { outcome: 'done', summary: 'earlier' } }); // a different stored result
        await events.recordProposals(job, other, parsed('blocked'));
        expect(sent).toHaveLength(0);

        await events.recordProposals(job, run, parsePrBody('no result block'));
        expect(sent).toHaveLength(0);
    });

    it('goes through linkPr: a stored blocked result notifies once, a run that is not updatable does not', async () => {
        const run = await freshRun();
        const pr = (body: string) => ({ number: 5, htmlUrl: 'u', body, headRef: 'b', headSha: 'sha1' });
        await events.linkPr(REPO, pr(RUN_BODY('blocked').replace('RUNID', run.id)));
        expect(sent.map((s) => s.event)).toEqual([{ type: 'run_outcome', outcome: 'blocked', jobId: J1, runId: run.id, repoId: REPO }]);

        // The conditional update refuses a run that already moved on (e.g. superseded): nothing is stored, nothing is sent.
        await ds.getRepository(Job).update({ id: J1 }, { status: 'dispatched', prNumber: null, headSha: null });
        const moved = await freshRun({ status: 'superseded' });
        sent.length = 0;
        await events.linkPr(REPO, pr(RUN_BODY('partial').replace('RUNID', moved.id)));
        expect(sent).toHaveLength(0);
    });

    it('an edited result notifies its new outcome, and a retried identical parse is handed over again for the receipt to dedupe', async () => {
        const run = await freshRun();
        const first = parsed('partial');
        await ds.getRepository(JobRun).update({ id: run.id }, { result: first.result });
        await events.recordProposals(job, run, first);

        const edited = parsed('blocked');
        await ds.getRepository(JobRun).update({ id: run.id }, { result: edited.result });
        await events.recordProposals(job, run, edited);
        await events.recordProposals(job, run, edited);
        expect(sent.map((s) => (s.event as { outcome: string }).outcome)).toEqual(['partial', 'blocked', 'blocked']);
    });

    it('a failing publisher or run lookup never breaks the hook', async () => {
        const failing = new ScoutSignalPublisher();
        failing.register(async () => { throw new Error('scout down'); });
        const ev = new JobEventsService(ds.getRepository(Job), ds.getRepository(JobRun), ds.getRepository(Project), undefined, undefined, undefined, undefined, failing);
        const run = await freshRun();
        const p = parsed('blocked');
        await ds.getRepository(JobRun).update({ id: run.id }, { result: p.result });
        await expect(ev.recordProposals(job, run, p)).resolves.toBeUndefined();
    });

    it('publishes nothing while the scout is off (no sink registered)', async () => {
        const off = new ScoutSignalPublisher();
        const publish = vi.spyOn(off, 'publish');
        const ev = new JobEventsService(ds.getRepository(Job), ds.getRepository(JobRun), ds.getRepository(Project), undefined, undefined, undefined, undefined, off);
        const run = await freshRun();
        await ev.recordProposals(job, run, parsed('blocked'));
        expect(publish).not.toHaveBeenCalled();
    });

    it('a merged PR publishes job_merged; a closed one does not', async () => {
        await events.prClosed({ ...job, status: 'awaiting_review' } as Job, 1, false);
        expect(sent).toHaveLength(0);
        await ds.getRepository(Job).update({ id: J1 }, { status: 'awaiting_review' });
        await events.prClosed({ ...job, status: 'awaiting_review' } as Job, 1, true);
        expect(sent.map((s) => s.event)).toEqual([{ type: 'job_merged', jobId: J1, repoId: REPO }]);
    });

    it('a park through retryOrParkJob publishes job_parked via the capture service, without the free-form reason', async () => {
        const { publisher, sent: parkSent } = recorder();
        const notifications = { recordQuietly: vi.fn(async () => false) };
        const capture = new NotificationCaptureService(notifications as never, ds.getRepository('Repo') as never, ds.getRepository(Job), ds.getRepository(Feature) as never, undefined, publisher);
        const ev = new JobEventsService(ds.getRepository(Job), ds.getRepository(JobRun), ds.getRepository(Project), undefined, undefined, undefined, capture);
        await ds.getRepository(Project).update({ id: P1 }, { maxAttempts: 1 });
        await ev.retryOrParkJob({ ...job, attempts: 1 } as Job, 'secret reason text');
        expect(parkSent).toHaveLength(1);
        expect(parkSent[0].event).toMatchObject({ type: 'job_parked', jobId: J1, repoId: REPO, attempts: 1, cause: 'failure' });
        expect(JSON.stringify(parkSent)).not.toContain('secret reason');
    });
});

describe('capture paths for parked jobs', () => {
    it.each(['failure', 'sent_back', 'dispatch'] as const)('jobParked(%s) publishes even when the inbox record already existed, and never throws', async (cause) => {
        const { publisher, sent } = recorder();
        const capture = new NotificationCaptureService({ recordQuietly: async () => false } as never, {} as never, {} as never, {} as never, undefined, publisher);
        const job = { id: J1, projectId: P1, repoId: REPO, attempts: 2, headSha: 'abc' } as Job;
        await expect(capture.jobParked(job, 'why', cause)).resolves.toBe(false);
        expect(sent[0].event).toEqual({ type: 'job_parked', jobId: J1, repoId: REPO, attempts: 2, cause, headSha: 'abc' });

        const throwing = new ScoutSignalPublisher();
        throwing.register(async () => { throw new Error('x'); });
        const safe = new NotificationCaptureService({ recordQuietly: async () => true } as never, {} as never, {} as never, {} as never, undefined, throwing);
        await expect(safe.jobParked(job, 'why', cause)).resolves.toBe(true);
    });
});

describe('FeedbackService changes_requested events', () => {
    let ds: DataSource;
    let sent: ReturnType<typeof recorder>['sent'];
    let service: FeedbackService;
    const make = (githubId: string, over: Partial<NewFeedback> = {}): NewFeedback => ({
        jobId: J1, projectId: P1, repoId: REPO, prNumber: 3, kind: 'review', githubId, author: 'a', authorAssociation: 'OWNER',
        state: 'changes_requested', reviewId: null, path: null, line: null, body: 'please fix the secret thing', url: 'u', ...over,
    });

    beforeEach(async () => {
        ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Feedback], synchronize: true }).initialize();
        const r = recorder();
        sent = r.sent;
        service = new FeedbackService(new FeedbackMapper(), ds.getRepository(Feedback), r.publisher);
    });
    afterEach(() => ds.destroy());

    it('publishes a newly stored changes_requested review, by feedback id', async () => {
        expect(await service.record(make('1'))).toBe(true);
        const stored = await ds.getRepository(Feedback).findOneByOrFail({ githubId: '1' });
        expect(sent).toEqual([{ projectId: P1, event: { type: 'changes_requested', jobId: J1, repoId: REPO, feedbackId: stored.id, prNumber: 3 } }]);
        expect(JSON.stringify(sent)).not.toContain('secret');
    });

    it('does not publish redelivered, approved, comment or review_comment feedback', async () => {
        await service.record(make('1'));
        sent.length = 0;
        expect(await service.record(make('1'))).toBe(false);
        await service.record(make('2', { state: 'approved' }));
        await service.record(make('3', { kind: 'comment', state: null }));
        await service.record(make('4', { kind: 'review_comment', state: 'changes_requested' }));
        expect(sent).toHaveLength(0);
    });

    it('a failing publisher does not fail the store', async () => {
        const failing = new ScoutSignalPublisher();
        failing.register(async () => { throw new Error('down'); });
        const s = new FeedbackService(new FeedbackMapper(), ds.getRepository(Feedback), failing);
        expect(await s.record(make('9'))).toBe(true);
    });
});

describe('LessonCollectorService lesson_created events', () => {
    let ds: DataSource;

    beforeEach(async () => { ds = await memoryDb(); });
    afterEach(() => ds.destroy());

    it('publishes each new lesson once, after its transaction committed, and never replays known sources', async () => {
        const { publisher, sent } = recorder();
        const collector = new LessonCollectorService(ds.getRepository(JobRun), ds.getRepository(Feedback), ds.getRepository(Lesson), ds.getRepository(LessonSource), publisher);
        await addRun(ds, { result: { outcome: 'done', summary: 's', suggestedLesson: 'Document the command' } });
        expect(await collector.collect()).toEqual({ created: 1 });
        const lesson = await ds.getRepository(Lesson).findOneByOrFail({ projectId: P1 });
        expect(sent).toEqual([{ projectId: P1, event: { type: 'lesson_created', lessonId: lesson.id, jobId: J1 } }]);
        expect(await ds.getRepository(LessonSource).count()).toBe(1);

        await collector.collect();
        expect(sent).toHaveLength(1);
    });

    it('a failing publisher does not undo or fail the collection', async () => {
        const failing = new ScoutSignalPublisher();
        failing.register(async () => { throw new Error('down'); });
        const collector = new LessonCollectorService(ds.getRepository(JobRun), ds.getRepository(Feedback), ds.getRepository(Lesson), ds.getRepository(LessonSource), failing);
        await addRun(ds, { result: { outcome: 'done', summary: 's', suggestedLesson: 'Another one' } });
        expect(await collector.collect()).toEqual({ created: 1 });
        expect(await ds.getRepository(Lesson).count()).toBe(1);
    });
});

describe('FeatureService feature_done events', () => {
    let ds: DataSource;
    let sent: ReturnType<typeof recorder>['sent'];
    let service: FeatureService;
    let features: ReturnType<DataSource['getRepository']>;

    beforeEach(async () => {
        ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [User, Feature, Job], synchronize: true }).initialize();
        const r = recorder();
        sent = r.sent;
        features = ds.getRepository(Feature);
        service = new FeatureService(new FeatureMapper(), {} as never, { listByFeature: async () => [] } as never, ds.getRepository(Feature), ds.getRepository(Job), undefined, undefined, r.publisher);
    });
    afterEach(() => ds.destroy());

    const mk = (status: string) => features.save(features.create({ projectId: P1, title: 'F', spec: 's', status })) as Promise<Feature>;

    it('publishes a successful active to done, with the doneAt as part of the occurrence', async () => {
        const f = await mk('active');
        await service.done(f.id);
        const done = await ds.getRepository(Feature).findOneByOrFail({ id: f.id });
        expect(sent).toEqual([{ projectId: P1, event: { type: 'feature_done', featureId: f.id, doneAt: done.doneAt!.toISOString() } }]);

        // Reopen and complete again: a new occurrence.
        await service.reopen(f.id);
        await new Promise((r) => setTimeout(r, 5));
        await service.done(f.id);
        expect(sent).toHaveLength(2);
        expect((sent[1].event as { doneAt: string }).doneAt).not.toBe((sent[0].event as { doneAt: string }).doneAt);
    });

    it('does not publish for a rejected transition, cancel or start', async () => {
        const draft = await mk('draft');
        await expect(service.done(draft.id)).rejects.toThrow();
        const active = await mk('active');
        await service.cancel(active.id);
        expect(sent).toHaveLength(0);
    });
});
