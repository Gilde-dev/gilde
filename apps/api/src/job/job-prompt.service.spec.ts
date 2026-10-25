import { Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentInstructionsService } from '../execution/agent-instructions.service.js';
import { User } from '../user/user.entity.js';
import { RoutineExecutionAdapter } from '../execution/routine-execution.adapter.js';
import { Feature } from '../feature/feature.entity.js';
import { JobRevision } from '../revision/revision.entity.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { JobDependency } from './job-dependency.entity.js';
import { JobPromptService } from './job-prompt.service.js';
import { Job } from './job.entity.js';

let ds: DataSource;
let service: JobPromptService;
let job: Job;
let searchLessons: ReturnType<typeof vi.fn>;

beforeEach(async () => {
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', entities: [User, Project, Repo, Job, JobRun, JobDependency, Feature, JobRevision], synchronize: true,
    }).initialize();
    const project = await ds.getRepository(Project).save({ slug: 'p', name: 'P' });
    const repo = await ds.getRepository(Repo).save({ projectId: project.id, fullName: 'o/r', stacks: ['node'], testCommands: ['pnpm test'] });
    job = await ds.getRepository(Job).save({
        projectId: project.id, repoId: repo.id, title: 'T', task: 'do', acceptanceCriteria: ['a'], status: 'queued', attempts: 1,
    });
    searchLessons = vi.fn().mockResolvedValue({ status: 'ok', lessons: [] });
    service = new JobPromptService(
        new RoutineExecutionAdapter(new AgentInstructionsService()),
        ds.getRepository(Job), ds.getRepository(Repo), ds.getRepository(Feature), { searchLessons } as never,
    );
});
afterEach(async () => {
    delete process.env.AGENT_INSTRUCTIONS_PATH;
    await ds.destroy();
});

describe('JobPromptService', () => {
    it('returns the payload text for the next attempt, without side effects', async () => {
        const res = await service.get(job.id);
        expect(res.instructionsVersion).toBeNull();
        expect(res.text).toContain(`Gilde job ${job.id} (attempt 2)`);
        expect(res.text).toContain('"testCommands":["pnpm test"]');
        expect(res.text).toContain('"stacks":["node"]');
        expect(await ds.getRepository(JobRun).count()).toBe(0);
        expect((await ds.getRepository(Job).findOneByOrFail({ id: job.id })).attempts).toBe(1);
    });

    it('lists downstream jobs', async () => {
        const next = await ds.getRepository(Job).save({
            projectId: job.projectId, repoId: job.repoId, title: 'Next', task: 'follow up work', status: 'queued',
        });
        await ds.getRepository(JobDependency).insert({ jobId: next.id, dependsOnJobId: job.id });
        const res = await service.get(job.id);
        expect(res.text).toContain(`"downstream":[{"jobId":"${next.id}","title":"Next","task":"follow up work","acceptanceCriteria":[],"dependsOn":["${job.id}"]}]`);
    });

    it('previews the same lessons a fire would send, without changing state', async () => {
        searchLessons.mockResolvedValue({ status: 'ok', lessons: [
            { lessonId: 'les1', projectId: job.projectId, targetRepoId: null, status: 'applied', score: 0.8, text: 'Stream large exports' },
            { lessonId: 'foreign', projectId: 'other', targetRepoId: null, status: 'approved', score: 0.9, text: 'Foreign' },
        ] });
        const res = await service.get(job.id);
        expect(searchLessons.mock.calls[0]![0]).toMatchObject({ projectId: job.projectId, repoId: job.repoId });
        expect(res.text).toContain('"lessons":[{"id":"les1","text":"Stream large exports","scope":"project","status":"applied","relevance":0.8}]');
        expect(res.text).not.toContain('Foreign');
        expect(await ds.getRepository(JobRun).count()).toBe(0);
        expect((await ds.getRepository(Job).findOneByOrFail({ id: job.id })).attempts).toBe(1);
    });

    it('previews without lessons when retrieval fails', async () => {
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        searchLessons.mockRejectedValue(new Error('429'));
        const res = await service.get(job.id);
        expect(res.text).not.toContain('lessons');
        vi.restoreAllMocks();
    });

    it('404s for an unknown job', async () => {
        await expect(service.get('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reports a missing instructions file as a 400', async () => {
        process.env.AGENT_INSTRUCTIONS_PATH = '/nonexistent/instructions.md';
        await expect(service.get(job.id)).rejects.toThrow(/missing or unreadable/);
    });
});
