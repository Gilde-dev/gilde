import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRun } from '../agent-run/agent-run.entity.js';
import { AgentRunRecorder } from '../agent-run/agent-run.recorder.js';
import { AgentToolCall } from '../agent-run/agent-tool-call.entity.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { MapperStub } from './job-events.agent-run.testing.js';
import { RunService } from '../run/run.service.js';
import { JobRun } from '../run/run.entity.js';
import { User } from '../user/user.entity.js';

import { JobEventsService } from './job-events.service.js';
import { Job } from './job.entity.js';

let ds: DataSource;
let recorder: AgentRunRecorder;
let runService: RunService;
let events: JobEventsService;
let job: Job;
const actor = randomUUID();

beforeEach(async () => {
    ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [User, Project, Repo, Job, JobRun, AgentRun, AgentToolCall], synchronize: true }).initialize();
    recorder = new AgentRunRecorder(ds.getRepository(AgentRun), ds.getRepository(AgentToolCall));
    runService = new RunService(new MapperStub() as never, ds.getRepository(JobRun), recorder);
    events = new JobEventsService(ds.getRepository(Job), ds.getRepository(JobRun), ds.getRepository(Project), undefined, undefined, undefined, undefined, undefined, recorder);
    const project = await ds.getRepository(Project).save({ slug: 'p', name: 'P' });
    const repo = await ds.getRepository(Repo).save({ projectId: project.id, fullName: 'o/r', defaultBranch: 'main', testCommands: ['t'] });
    job = await ds.getRepository(Job).save(ds.getRepository(Job).create({ projectId: project.id, repoId: repo.id, title: 'T', task: 't', status: 'dispatched', attempts: 1 }));
});
afterEach(() => ds.destroy());

const startRun = async () => {
    const run = await runService.create({ jobId: job.id, projectId: job.projectId, repoId: job.repoId, attempt: 1, executorId: null }, actor);
    await recorder.flush();
    return run;
};
const agentRun = async (jobRunId: string) => { await recorder.flush(); return ds.getRepository(AgentRun).findOneByOrFail({ linkedId: jobRunId }); };
const prBody = (runId: string, result: object) =>
    `Did it.\n\ngilde-job: ${job.id}\ngilde-run: ${runId}\n\n\`\`\`gilde-result\n${JSON.stringify({ testsRun: true, testsPassed: true, suggestedLesson: null, ...result })}\n\`\`\`\n`;
const pr = (body: string) => ({ number: 5, htmlUrl: 'u', headRef: 'b', headSha: 'sha1', body }) as never;

describe('the run log of coding-agent job runs', () => {
    it('starts with the job run: a dispatch run of the job, for the executor owner, linked to job_runs', async () => {
        const run = await startRun();
        expect(await agentRun(run.id)).toMatchObject({
            agentId: 'coding', triggerKind: 'dispatch', triggerRefType: 'job', triggerRefId: job.id, actorUserId: actor, projectId: job.projectId,
            linkedTable: 'job_runs', linkedId: run.id, endedAt: null, outcome: null,
        });
    });

    it('ends ok when the agent opened its PR', async () => {
        const run = await startRun();
        await events.linkPr(job.repoId, pr(prBody(run.id, { outcome: 'done', summary: 'All good' })));
        expect(await agentRun(run.id)).toMatchObject({ outcome: 'ok', reason: null });
        expect((await agentRun(run.id)).endedAt).not.toBeNull();
    });

    it('records a partial result with its summary, and a blocked run as refused', async () => {
        const run = await startRun();
        await events.linkPr(job.repoId, pr(prBody(run.id, { outcome: 'partial', summary: 'Half of it' })));
        expect(await agentRun(run.id)).toMatchObject({ outcome: 'ok', reason: 'partial: Half of it' });

        await ds.getRepository(Job).update({ id: job.id }, { status: 'dispatched', prNumber: null, headSha: null, attempts: 2 });
        const blocked = await runService.create({ jobId: job.id, projectId: job.projectId, repoId: job.repoId, attempt: 2, executorId: null }, actor);
        await events.linkPr(job.repoId, pr(prBody(blocked.id, { outcome: 'blocked', summary: 'The premise is wrong' })));
        expect(await agentRun(blocked.id)).toMatchObject({ outcome: 'refused', reason: 'The premise is wrong' });
    });

    it('ends with an error when the fire failed', async () => {
        const run = await startRun();
        await runService.markFailed(run.id, 'Executor rejected the token');
        expect(await agentRun(run.id)).toMatchObject({ outcome: 'error', reason: 'Executor rejected the token' });
    });

    it('a secret in a failure is redacted', async () => {
        const run = await startRun();
        await runService.markFailed(run.id, 'fire failed for Bearer abcdefghijklmnop12345 with sk-proj-abcdefghijklmnop');
        const row = await agentRun(run.id);
        expect(row.reason).not.toContain('abcdefghijklmnop');
        expect(row.reason).toContain('[redacted]');
    });

    it('ends as skipped when the PR is closed while the run was still going', async () => {
        const run = await startRun();
        await ds.getRepository(Job).update({ id: job.id }, { status: 'queued', prNumber: 5 });
        await events.prClosed((await ds.getRepository(Job).findOneBy({ id: job.id }))!, 5, false);
        expect(await agentRun(run.id)).toMatchObject({ outcome: 'skipped' });
    });

    it('a retry of a fire_failed run opens a new log entry for the same job run', async () => {
        const run = await startRun();
        await runService.markFailed(run.id, 'boom');
        runService.logStart({ id: run.id, jobId: job.id, projectId: job.projectId }, actor);
        await recorder.flush();
        const rows = await ds.getRepository(AgentRun).find({ where: { linkedId: run.id }, order: { startedAt: 'ASC' } });
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.outcome)).toEqual(['error', null]);
    });

    it('works without a recorder (tests and tools that build the services by hand)', async () => {
        const plain = new RunService(new MapperStub() as never, ds.getRepository(JobRun));
        const run = await plain.create({ jobId: job.id, projectId: job.projectId, repoId: job.repoId, attempt: 1, executorId: null });
        await expect(plain.markFailed(run.id, 'x')).resolves.toBeUndefined();
        expect(await ds.getRepository(AgentRun).count()).toBe(0);
    });
});
