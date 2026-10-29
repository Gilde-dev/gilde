import { prepareJobPrompt } from '../execution/job-prompt.js';
import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DispatcherService } from '../dispatch/dispatcher.service.js';
import { User } from '../user/user.entity.js';
import { loadDownstream, loadDownstreamContext } from '../execution/downstream.js';
import type { ExecutionPort } from '../execution/execution.port.js';
import { Executor } from '../executor/executor.entity.js';
import { Feature } from '../feature/feature.entity.js';
import { Feedback } from '../feedback/feedback.entity.js';
import { FeedbackMapper } from '../feedback/feedback.mapper.js';
import { FeedbackService } from '../feedback/feedback.service.js';
import { JobDependency } from '../job/job-dependency.entity.js';
import { JobEventsService } from '../job/job-events.service.js';
import type { JobStatus } from '../job/job-state.js';
import { Job } from '../job/job.entity.js';
import { JobMapper } from '../job/job.mapper.js';
import { JobService } from '../job/job.service.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { RepoMapper } from '../repo/repo.mapper.js';
import { RepoService } from '../repo/repo.service.js';
import { JobRun } from '../run/run.entity.js';
import { RunMapper } from '../run/run.mapper.js';
import { RunService } from '../run/run.service.js';
import { WebhookService } from '../webhook/webhook.service.js';
import { NotificationCaptureService } from '../notification/notification-capture.service.js';
import { Notification } from '../notification/notification.entity.js';
import { NotificationMapper } from '../notification/notification.mapper.js';
import { NotificationService } from '../notification/notification.service.js';
import { ProposalService } from './proposal.service.js';
import { JobRevision } from './revision.entity.js';
import { RevisionService } from './revision.service.js';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

let ds: DataSource;
let jobs: Repository<Job>;
let runs: Repository<JobRun>;
let revisions: Repository<JobRevision>;
let deps: Repository<JobDependency>;
let revisionService: RevisionService;
let notifications: Repository<Notification>;
let webhook: WebhookService;
let project: Project;
let repo: Repo;
let seq = 0;

beforeEach(async () => {
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:',
        entities: [User, Executor, Project, Repo, Job, JobRun, JobDependency, Feature, JobRevision, Feedback, Notification], synchronize: true,
    }).initialize();
    jobs = ds.getRepository(Job);
    runs = ds.getRepository(JobRun);
    revisions = ds.getRepository(JobRevision);
    deps = ds.getRepository(JobDependency);
    const projects = ds.getRepository(Project);
    const repos = ds.getRepository(Repo);
    project = await projects.save(projects.create({ slug: 'p', name: 'P' }));
    repo = await repos.save(repos.create({
        projectId: project.id, fullName: 'o/r', testCommands: ['x'], routineFireUrl: 'https://fire', routineTokenEnv: 'TOKEN',
    }));
    const repoService = { findByFullName: () => repos.findOneBy({ id: repo.id }), getById: () => repos.findOneByOrFail({ id: repo.id }) };
    const jobService = new JobService(new JobMapper(), repoService as never, {} as never, {} as never, jobs, deps, ds.getRepository(Feature));
    revisionService = new RevisionService(jobService, revisions, jobs, runs, deps);
    notifications = ds.getRepository(Notification);
    const capture = new NotificationCaptureService(new NotificationService(notifications, new NotificationMapper()), repos, jobs, ds.getRepository(Feature));
    const events = new JobEventsService(jobs, runs, projects, undefined, undefined, new ProposalService(jobs, runs, revisions, capture), capture);
    webhook = new WebhookService(
        repoService as never, new FeedbackService(new FeedbackMapper(), ds.getRepository(Feedback)), jobs, runs, projects, events,
    );
});

afterEach(() => ds.destroy());

async function seedJob(status: JobStatus = 'queued', over: Partial<Job> = {}) {
    seq++;
    return jobs.save(jobs.create({
        projectId: project.id, repoId: repo.id, title: `Job ${seq}`, task: 'original task text', acceptanceCriteria: ['a'],
        status, queuedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)), ...over,
    }));
}
async function seedRun(job: Job, result: JobRun['result'] = null) {
    return runs.save(runs.create({ jobId: job.id, projectId: job.projectId, repoId: job.repoId, attempt: 1, status: 'pr_opened', result }));
}
async function seedRevision(job: Job, over: Partial<JobRevision> = {}) {
    return revisions.save(revisions.create({ jobId: job.id, reason: 'because', ...over }));
}
const reload = (id: string) => jobs.findOneByOrFail({ id });

function prBody(job: Job, run: JobRun, proposals: string | null) {
    return [
        'Did it.', '', `gilde-job: ${job.id}`, `gilde-run: ${run.id}`, '',
        '```gilde-result', '{"outcome":"done","summary":"ok"}', '```',
        ...(proposals === null ? [] : ['', '```gilde-proposals', proposals, '```']),
    ].join('\n');
}
function edited(job: Job, run: JobRun, proposals: string | null) {
    return webhook.handle('pull_request', {
        action: 'edited',
        repository: { full_name: 'o/r' },
        pull_request: {
            number: 12, html_url: 'https://x/pull/12', body: prBody(job, run, proposals), head: { ref: 'b', sha: SHA },
        },
    });
}
const proposal = (jobId: string, over: Record<string, unknown> = {}) =>
    JSON.stringify([{ jobId, task: 'revised task text', reason: 'built it differently', ...over }]);

describe('proposals from a PR body', () => {
    let own: Job;
    let run: JobRun;
    beforeEach(async () => {
        own = await seedJob('pr_open', { prNumber: 12 });
        run = await seedRun(own);
    });

    it('creates proposed revisions for unstarted jobs and for the PR job itself', async () => {
        const next = await seedJob('queued');
        const triage = await seedJob('triage');
        await edited(own, run, JSON.stringify([
            { jobId: next.id, task: 'revised task text', reason: 'r1' },
            { jobId: triage.id, title: 'New title', dependsOn: [next.id], reason: 'r2' },
            { jobId: own.id, task: 'my own better task', reason: 'r3' },
        ]));
        const all = await revisions.find({ order: { createdAt: 'ASC' } });
        expect(all).toHaveLength(3);
        expect(all.every((r) => r.status === 'proposed' && r.sourceRunId === run.id && r.revision === null)).toBe(true);
        expect(all[1]).toMatchObject({ jobId: triage.id, title: 'New title', task: null, dependsOn: [next.id] });
        expect((await runs.findOneByOrFail({ id: run.id })).proposalsError).toBeNull();
    });

    it('ignores jobs that have started and jobs in another project', async () => {
        const started = await seedJob('dispatched');
        const otherProject = await ds.getRepository(Project).save({ slug: 'q', name: 'Q' });
        const otherRepo = await ds.getRepository(Repo).save({ projectId: otherProject.id, fullName: 'o/q', testCommands: ['x'] });
        const foreign = await jobs.save(jobs.create({
            projectId: otherProject.id, repoId: otherRepo.id, title: 'F', task: 'foreign task', status: 'queued',
        }));
        await edited(own, run, JSON.stringify([
            { jobId: started.id, task: 'revised task text', reason: 'r' },
            { jobId: foreign.id, task: 'revised task text', reason: 'r' },
        ]));
        expect(await revisions.count()).toBe(0);
    });

    it('records invalid JSON as a run error without failing the webhook', async () => {
        expect(await edited(own, run, '[{nope')).toContain('updated result');
        expect(await revisions.count()).toBe(0);
        expect((await runs.findOneByOrFail({ id: run.id })).proposalsError).toBe('gilde-proposals is not valid JSON');
    });

    it('does not duplicate proposals when the body is edited again, and follows the new content', async () => {
        const next = await seedJob('queued');
        await edited(own, run, proposal(next.id));
        await edited(own, run, proposal(next.id));
        expect(await revisions.count()).toBe(1);
        await edited(own, run, proposal(next.id, { task: 'a third version of it' }));
        expect(await revisions.find()).toMatchObject([{ task: 'a third version of it' }]);
        await edited(own, run, null);
        expect(await revisions.count()).toBe(0);
    });

    it('does not re-propose what was already decided', async () => {
        const next = await seedJob('queued');
        await edited(own, run, proposal(next.id));
        await revisionService.reject((await revisions.findOneByOrFail({ jobId: next.id })).id);
        await edited(own, run, proposal(next.id));
        expect(await revisions.find()).toMatchObject([{ status: 'rejected' }]);
    });
});

describe('RevisionService', () => {
    it('applies only the non-null fields, numbers the revision and rejects its siblings', async () => {
        const job = await seedJob('queued');
        const a = await seedRevision(job, { title: 'Better title' });
        const b = await seedRevision(job, { task: 'another task entirely' });
        const dto = await revisionService.accept(a.id);
        expect(dto).toMatchObject({ status: 'accepted', revision: 1 });
        expect(dto.decidedAt).not.toBeNull();
        expect(await reload(job.id)).toMatchObject({ title: 'Better title', task: 'original task text', acceptanceCriteria: ['a'] });
        expect(await revisions.findOneByOrFail({ id: b.id })).toMatchObject({ status: 'rejected' });
        expect((await revisions.findOneByOrFail({ id: b.id })).decidedAt).not.toBeNull();

        const c = await seedRevision(job, { acceptanceCriteria: ['x1x', 'y2y'] });
        expect(await revisionService.accept(c.id)).toMatchObject({ revision: 2 });
        expect((await reload(job.id)).acceptanceCriteria).toEqual(['x1x', 'y2y']);
    });

    it('replaces dependencies and returns 400 for a cycle', async () => {
        const a = await seedJob('queued');
        const b = await seedJob('queued');
        await deps.insert({ jobId: b.id, dependsOnJobId: a.id });
        await expect(revisionService.accept((await seedRevision(a, { dependsOn: [b.id] })).id)).rejects.toBeInstanceOf(BadRequestException);
        expect(await revisions.countBy({ status: 'proposed' })).toBe(1);

        await revisionService.accept((await seedRevision(b, { dependsOn: [] })).id);
        expect(await deps.countBy({ jobId: b.id })).toBe(0);
    });

    it('returns 409 for a job that has started, and for a decided revision', async () => {
        const started = await seedJob('dispatched');
        const rev = await seedRevision(started, { task: 'too late for this one' });
        await expect(revisionService.accept(rev.id)).rejects.toBeInstanceOf(ConflictException);
        await revisionService.reject(rev.id);
        await expect(revisionService.accept(rev.id)).rejects.toBeInstanceOf(ConflictException);
        await expect(revisionService.reject(rev.id)).rejects.toBeInstanceOf(ConflictException);
    });

    it('reject only sets status and decided_at', async () => {
        const job = await seedJob('queued');
        const rev = await seedRevision(job, { title: 'Nope nope' });
        expect(await revisionService.reject(rev.id)).toMatchObject({ status: 'rejected', revision: null });
        expect(await reload(job.id)).toMatchObject({ title: job.title, status: 'queued' });
    });

    it.each([['parked', 'manual_retry'], ['awaiting_review', 'retry']] as const)(
        'requeues a %s job that accepts its own blocked revision',
        async (status) => {
            const job = await seedJob(status, { prNumber: 12 });
            const run = await seedRun(job, { outcome: 'blocked', summary: 'task does not fit' });
            const rev = await seedRevision(job, { task: 'a task that fits the code', sourceRunId: run.id });
            await revisionService.accept(rev.id);
            expect(await reload(job.id)).toMatchObject({ status: 'queued', task: 'a task that fits the code' });
        },
    );

    it('does not requeue when the run did not report blocked or belongs to another job', async () => {
        const job = await seedJob('parked');
        const done = await seedRun(job, { outcome: 'done', summary: 'ok' });
        await expect(revisionService.accept((await seedRevision(job, { task: 'x'.repeat(12), sourceRunId: done.id })).id))
            .rejects.toBeInstanceOf(ConflictException);
        const other = await seedJob('pr_open');
        const blocked = await seedRun(other, { outcome: 'blocked', summary: 'no' });
        await expect(revisionService.accept((await seedRevision(job, { task: 'x'.repeat(12), sourceRunId: blocked.id })).id))
            .rejects.toBeInstanceOf(ConflictException);
    });

    it('lists by project and status with the current job and the proposing PR', async () => {
        const own = await seedJob('pr_open', { prNumber: 12, prUrl: 'https://x/pull/12' });
        const run = await seedRun(own);
        const job = await seedJob('queued');
        const rev = await seedRevision(job, { task: 'something else entirely', sourceRunId: run.id });
        await seedRevision(job, { title: 'Decided one', status: 'rejected' });
        const list = await revisionService.list({ projectId: project.id, status: 'proposed' });
        expect(list).toMatchObject([{ id: rev.id, job: { id: job.id, task: 'original task text' }, pr: { number: 12, url: 'https://x/pull/12' } }]);
        expect(await revisionService.list({ projectId: '00000000-0000-0000-0000-000000000000' })).toEqual([]);
        expect(await revisionService.listForJob(job.id)).toHaveLength(2);
    });
});

describe('dispatch with revisions', () => {
    it('does not fire a queued job with a proposed revision until it is decided', async () => {
        const fire = vi.fn().mockResolvedValue({ sessionId: 's', sessionUrl: 'https://x/s' });
        const execution: ExecutionPort = { fire: (r, i) => fire(r, 'prepared' in i ? i.payload : i), prepare: (p, c) => prepareJobPrompt(p, { text: null, version: null }, c) };
        const repoService = new RepoService(new RepoMapper(), {} as never, ds.getRepository(Repo));
        const owner = await ds.getRepository(User).save(ds.getRepository(User).create({ email: 'o@example.com', name: 'O', password: 'x' }));
        const executors = ds.getRepository(Executor);
        await executors.save(executors.create({
            ownerId: owner.id, name: 'mine', fireUrl: 'https://fire', repoIds: [repo.id], tokenLast4: 'oken', maxConcurrent: 5, dailyRunLimit: null, enabled: true, exhaustedUntil: null,
        }));
        const executorService = { listForDispatch: (ownerId: string) => executors.find({ where: { ownerId } }), revealToken: async () => 'tok' };
        const dispatcher = new DispatcherService(
            new RunService(new RunMapper(), runs), execution, jobs, ds.getRepository(Repo), ds.getRepository(Project), runs,
            repoService, ds.getRepository(Feature), undefined as never,
            { status: async () => ({ hardBlocked: false }) } as never, { capture: async () => 0 } as never, executorService as never,
        );
        const job = await seedJob('queued', { createdById: owner.id });
        const rev = await seedRevision(job, { task: 'a revised task text' });
        expect(await dispatcher.dispatch()).toMatchObject({ fired: 0, failed: 0 });
        await revisionService.reject(rev.id);
        expect(await dispatcher.dispatch()).toMatchObject({ fired: 1, failed: 0 });

        const second = await seedJob('queued', { createdById: owner.id });
        const pending = await seedRevision(second, { title: 'Another title' });
        await revisionService.accept(pending.id);
        expect(await dispatcher.dispatch()).toMatchObject({ fired: 1, failed: 0 });
        expect(fire.mock.calls[1][1]).toMatchObject({ title: 'Another title' });
    });
});

describe('loadDownstream', () => {
    it('returns transitive dependents and unstarted feature jobs, but not started ones or itself', async () => {
        const feature = await ds.getRepository(Feature).save(ds.getRepository(Feature).create({
            projectId: project.id, title: 'F', spec: 's', status: 'active',
        } as never));
        const root = await seedJob('dispatched', { featureId: feature.id });
        const child = await seedJob('queued');
        const grandchild = await seedJob('triage');
        const merged = await seedJob('merged');
        const sibling = await seedJob('queued', { featureId: feature.id, task: 't'.repeat(5000) });
        await seedJob('dispatched', { featureId: feature.id });
        await deps.insert([
            { jobId: child.id, dependsOnJobId: root.id },
            { jobId: grandchild.id, dependsOnJobId: child.id },
            { jobId: merged.id, dependsOnJobId: root.id },
        ]);
        const down = await loadDownstream(ds.manager, root);
        expect(down.map((d) => d.jobId).sort()).toEqual([child.id, grandchild.id, sibling.id].sort());
        expect(down.find((d) => d.jobId === grandchild.id)?.dependsOn).toEqual([child.id]);
        expect(down.find((d) => d.jobId === sibling.id)?.task).toHaveLength(4000);
    });

    it('is empty for a job without dependents and without a feature, whatever else is in the database', async () => {
        const lone = await seedJob('dispatched');
        await seedJob('queued');
        await seedJob('triage', { task: 't'.repeat(5000) });
        await seedJob('merged');
        expect(await loadDownstream(ds.manager, lone)).toEqual([]);
    });

    it('only includes the feature siblings when the job has no dependents', async () => {
        const feature = await ds.getRepository(Feature).save(ds.getRepository(Feature).create({
            projectId: project.id, title: 'F', spec: 's', status: 'active',
        } as never));
        const root = await seedJob('dispatched', { featureId: feature.id });
        const sibling = await seedJob('queued', { featureId: feature.id });
        await seedJob('queued'); // unrelated
        expect((await loadDownstream(ds.manager, root)).map((d) => d.jobId)).toEqual([sibling.id]);
    });

    it('caps the list at 20', async () => {
        const root = await seedJob('dispatched');
        for (let i = 0; i < 25; i++) {
            const j = await seedJob('queued');
            await deps.insert({ jobId: j.id, dependsOnJobId: root.id });
        }
        expect(await loadDownstream(ds.manager, root)).toHaveLength(20);
    });

    it('classifies dependents from the full graph, orders by age then id, and reports the initial cutoffs', async () => {
        const feature = await ds.getRepository(Feature).save(ds.getRepository(Feature).create({
            projectId: project.id, title: 'F', spec: 's', status: 'active',
        } as never));
        const root = await seedJob('dispatched', { featureId: feature.id });
        const sameTime = new Date('2026-01-01T00:00:00Z');
        const siblings: Job[] = [];
        for (let i = 0; i < 20; i++) siblings.push(await seedJob('queued', { featureId: feature.id, createdAt: sameTime }));
        // A dependent that is younger than 20 siblings falls beyond the cutoff but is still classified from the graph.
        const late = await seedJob('queued', { featureId: feature.id, createdAt: new Date('2026-06-01T00:00:00Z') });
        await deps.insert({ jobId: late.id, dependsOnJobId: root.id });
        // The over-long task sits on the oldest job, which is always included: the 20 tied siblings are cut by random id,
        // so a long task on one of them made taskCapped depend on which sibling fell beyond the cutoff (flaky, 1 in 20).
        const early = await seedJob('queued', { createdAt: new Date('2025-01-01T00:00:00Z'), task: 't'.repeat(4500) });
        await deps.insert({ jobId: early.id, dependsOnJobId: root.id });

        const ctx = await loadDownstreamContext(ds.manager, root);
        expect(ctx.jobs).toHaveLength(20);
        expect(ctx.jobs[0].jobId).toBe(early.id);
        expect(ctx.dependents).toEqual(new Set([early.id]));
        expect(ctx.omitted).toBe(2);
        expect(ctx.taskCapped).toBe(true);
        expect(siblings).toHaveLength(20);
        const tied = ctx.jobs.slice(1).map((j) => j.jobId);
        expect(tied).toEqual([...tied].sort());
        // Nothing internal leaks into the entries the agent sees.
        expect(Object.keys(ctx.jobs[0]).sort()).toEqual(['acceptanceCriteria', 'dependsOn', 'jobId', 'task', 'title']);
    });
});

describe('revision.waiting notifications', () => {
    let own: Job;
    let run: JobRun;
    beforeEach(async () => {
        own = await seedJob('pr_open', { prNumber: 12, prUrl: 'https://x/pull/12' });
        run = await seedRun(own);
    });
    const rows = () => notifications.find({ order: { createdAt: 'ASC' } });

    it('records one event per saved proposal, linking the proposing run PR and the target job', async () => {
        const next = await seedJob('queued');
        await edited(own, run, proposal(next.id));
        const all = await rows();
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({
            kind: 'revision.waiting', jobId: next.id, projectId: project.id, title: next.title, repos: ['o/r'],
            reason: 'built it differently', prLinks: [{ repo: 'o/r', number: 12, url: 'https://x/pull/12' }],
        });
        expect(all[0].occurrenceKey).toMatch(new RegExp(`^revision\\.waiting:${run.id}:${next.id}:[0-9a-f]{32}$`));
    });

    it('deduplicates an unchanged proposal that is re-parsed (rows are deleted and recreated)', async () => {
        const next = await seedJob('queued');
        await edited(own, run, proposal(next.id));
        const first = await revisions.findOneByOrFail({ jobId: next.id });
        await edited(own, run, proposal(next.id));
        await edited(own, run, proposal(next.id));
        expect((await revisions.findOneByOrFail({ jobId: next.id })).id).not.toBe(first.id);
        expect(await notifications.count()).toBe(1);
    });

    it('notifies again for a meaningful edit, and for the same content from another run', async () => {
        const next = await seedJob('queued');
        await edited(own, run, proposal(next.id));
        await edited(own, run, proposal(next.id, { task: 'a different revised task' }));
        await edited(own, run, proposal(next.id, { reason: 'another reason' }));
        expect(await notifications.count()).toBe(3);

        const run2 = await runs.save(runs.create({ jobId: own.id, projectId: own.projectId, repoId: own.repoId, attempt: 2, status: 'pr_opened' }));
        await edited(own, run2, proposal(next.id, { reason: 'another reason' }));
        expect(await notifications.count()).toBe(4);
    });

    it('records nothing for decided, started, foreign-project or invalid proposals', async () => {
        const decided = await seedJob('queued');
        await seedRevision(decided, { sourceRunId: run.id, status: 'rejected' });
        const started = await seedJob('dispatched');
        const otherProject = await ds.getRepository(Project).save({ slug: 'q', name: 'Q' });
        const otherRepo = await ds.getRepository(Repo).save({ projectId: otherProject.id, fullName: 'o/q', testCommands: ['x'] });
        const foreign = await jobs.save(jobs.create({ projectId: otherProject.id, repoId: otherRepo.id, title: 'F', task: 't', status: 'queued' }));
        for (const j of [decided, started, foreign]) await edited(own, run, proposal(j.id));
        await edited(own, run, 'not json');
        expect(await notifications.count()).toBe(0);
    });

    it('acceptance and rejection do not record anything', async () => {
        const next = await seedJob('queued');
        await edited(own, run, proposal(next.id));
        const rev = await revisions.findOneByOrFail({ jobId: next.id });
        await revisionService.accept(rev.id);
        expect(await notifications.count()).toBe(1);
    });

    it('still saves the proposal when the insert or the enrichment read fails', async () => {
        const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const next = await seedJob('queued');
        const insert = vi.spyOn(notifications, 'insert').mockRejectedValue(new Error('insert down'));
        await edited(own, run, proposal(next.id));
        expect(await revisions.countBy({ jobId: next.id, status: 'proposed' })).toBe(1);

        insert.mockRestore();
        const other = await seedJob('queued');
        const repos = ds.getRepository(Repo);
        const lookup = repos.findOneBy.bind(repos);
        let calls = 0; // the webhook resolves its repo first; the capture's enrichment read follows
        vi.spyOn(repos, 'findOneBy').mockImplementation((...args) => (calls++ === 0 ? lookup(...args) : Promise.reject(new Error('read down'))));
        await edited(own, run, proposal(other.id));
        expect(await revisions.countBy({ jobId: other.id, status: 'proposed' })).toBe(1);
        expect(await notifications.count()).toBe(0);
        expect(log).toHaveBeenCalled();
        vi.restoreAllMocks();
    });
});
