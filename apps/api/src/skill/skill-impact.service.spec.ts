import { NotFoundException } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Job } from '../job/job.entity.js';
import type { JobStatus } from '../job/job-state.js';
import { AgentUsage } from '../otel/agent-usage.entity.js';
import { Project } from '../project/project.entity.js';
import type { ProjectService } from '../project/project.service.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRevision } from '../revision/revision.entity.js';
import { JobRun } from '../run/run.entity.js';
import { User } from '../user/user.entity.js';

import { SkillImpactService } from './skill-impact.service.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const UNKNOWN = '00000000-0000-4000-8000-000000000000';
const SKILL = { name: 'pnpm', hash: 'h1', managedBy: 'gildeboek@v1' };

let ds: DataSource;
let service: SkillImpactService;
let jobs: Repository<Job>;
let runs: Repository<JobRun>;
let revisions: Repository<JobRevision>;
let usage: Repository<AgentUsage>;
let project: Project;
let other: Project;
let repo: Repo;
let otherRepo: Repo;

const ctx = (skills: JobRun['context'] extends infer C ? (C extends { skills: infer S } ? S : never) : never) =>
    ({ gildeboekVersion: 'v1', skills, agentsMdHash: null, capturedAt: NOW.toISOString() });

beforeEach(async () => {
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', entities: [User, Project, Repo, Job, JobRun, JobRevision, AgentUsage], synchronize: true,
    }).initialize();
    jobs = ds.getRepository(Job);
    runs = ds.getRepository(JobRun);
    revisions = ds.getRepository(JobRevision);
    usage = ds.getRepository(AgentUsage);
    const projects = ds.getRepository(Project);
    const repos = ds.getRepository(Repo);
    project = await projects.save(projects.create({ slug: 'p', name: 'P' }));
    other = await projects.save(projects.create({ slug: 'q', name: 'Q' }));
    repo = await repos.save(repos.create({ projectId: project.id, fullName: 'o/a', testCommands: ['t'] }));
    otherRepo = await repos.save(repos.create({ projectId: other.id, fullName: 'o/b', testCommands: ['t'] }));
    const projectService = {
        assertExists: async (id: string) => { if (!(await projects.existsBy({ id }))) throw new NotFoundException(); },
    } as unknown as ProjectService;
    service = new SkillImpactService(projectService, { minRuns: 2 }, runs, jobs, revisions, usage);
});

afterEach(() => ds.destroy());

async function seed(status: JobStatus, o: { skills?: typeof SKILL[]; r?: Repo; ageDays?: number; run?: Partial<JobRun>; job?: Partial<Job> } = {}) {
    const r = o.r ?? repo;
    const job = await jobs.save(jobs.create({ projectId: r.projectId, repoId: r.id, title: 'T', task: 'x', status, queuedAt: new Date(), attempts: 1, ...o.job }));
    const run = await runs.save(runs.create({
        jobId: job.id, projectId: r.projectId, repoId: r.id, attempt: 1, status: 'fired',
        context: ctx(o.skills ?? [SKILL]), result: { outcome: 'done', summary: 's', testsRun: true, testsPassed: true } as JobRun['result'], ...o.run,
    }));
    await runs.update({ id: run.id }, { createdAt: new Date(NOW.getTime() - (o.ageDays ?? 1) * 86_400_000) });
    return { job, run };
}

describe('SkillImpactService', () => {
    it('is 404 for an unknown project', async () => {
        await expect(service.impact(UNKNOWN, 30, NOW)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('compares finished runs with and without a skill and ignores unfinished runs', async () => {
        await seed('merged');
        await seed('rejected', { run: { ciConclusion: 'failure', result: { outcome: 'partial' } as JobRun['result'] } });
        await seed('awaiting_review');
        await seed('merged', { skills: [] });
        await seed('parked', { skills: [], run: { result: { outcome: 'blocked' } as JobRun['result'] } });
        const { skills, minRuns, days } = await service.impact(project.id, 30, NOW);
        expect([minRuns, days]).toEqual([2, 30]);
        const v = skills[0].versions[0];
        expect(v.with).toMatchObject({ n: 2, insufficient: false, counts: { done: 1, partial: 1, merged: 1, rejectedOrParked: 1, ciFailed: 1 } });
        expect(v.without).toMatchObject({ n: 2, counts: { blocked: 1, merged: 1, rejectedOrParked: 1 } });
    });

    it('treats a superseded attempt as finished, counts accepted revisions and attributed tokens', async () => {
        const first = await seed('merged', { run: { attempt: 1 } });
        await runs.save(runs.create({ jobId: first.job.id, projectId: project.id, repoId: repo.id, attempt: 2, status: 'fired', context: ctx([SKILL]) }));
        await revisions.save(revisions.create({ jobId: first.job.id, reason: 'r', status: 'accepted' }));
        await revisions.save(revisions.create({ jobId: first.job.id, reason: 'r', status: 'rejected' }));
        await usage.save(usage.create({
            runId: first.run.id, sessionId: 's', model: 'm', inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40, eventAt: NOW, eventKey: 'k1',
        }));
        const v = (await service.impact(project.id, 30, NOW)).skills[0].versions[0];
        // Both attempts belong to a merged job and are finished: attempt 1 is superseded, attempt 2 ended with the job.
        expect(v.with.n).toBe(2);
        expect(v.with.avgRevisionRounds).toBe(1);
        expect(v.with.medianTokens).toBe(100);
        expect(v.with.tokensN).toBe(1);
    });

    it('skips runs that never started an agent or have no recorded context', async () => {
        await seed('merged');
        await seed('merged', { run: { status: 'fire_failed' } });
        await seed('merged', { run: { context: null } });
        expect((await service.impact(project.id, 30, NOW)).skills[0].versions[0].with.n).toBe(1);
    });

    it('does not let a never-started later attempt supersede a run', async () => {
        const { job } = await seed('dispatched');
        await runs.save(runs.create({ jobId: job.id, projectId: project.id, repoId: repo.id, attempt: 2, status: 'fire_failed', context: ctx([SKILL]) }));
        expect((await service.impact(project.id, 30, NOW)).skills[0].versions[0].with.n).toBe(0);
    });

    it('does not count a merged-blocked job as merged', async () => {
        await seed('merged', { job: { mergedBlocked: true } });
        const v = (await service.impact(project.id, 30, NOW)).skills[0].versions[0];
        expect(v.with.counts.merged).toBe(0);
    });

    it('is scoped to the project', async () => {
        await seed('merged');
        await seed('merged', { r: otherRepo });
        const { skills } = await service.impact(project.id, 30, NOW);
        expect(skills[0].versions[0].with.n).toBe(1);
        expect((await service.impact(other.id, 30, NOW)).skills[0].versions[0].with.n).toBe(1);
    });

    it('limits the window to the requested days and defaults to 30', async () => {
        await seed('merged', { ageDays: 5 });
        await seed('merged', { ageDays: 20 });
        await seed('merged', { ageDays: 40 });
        const count = async (days?: number) => (await service.impact(project.id, days, NOW)).skills[0]?.versions[0].with.n ?? 0;
        expect(await count(7)).toBe(1);
        expect(await count(30)).toBe(2);
        expect(await count(undefined)).toBe(2);
        expect(await count(180)).toBe(3);
    });
});
