import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { User } from '../user/user.entity.js';
import { JobEventsService } from './job-events.service.js';
import { Job } from './job.entity.js';
import type { JobStatus } from './job-state.js';

let ds: DataSource;
let service: JobEventsService;

beforeEach(async () => {
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', entities: [User, Project, Repo, Job, JobRun], synchronize: true,
    }).initialize();
    service = new JobEventsService(ds.getRepository(Job), ds.getRepository(JobRun), ds.getRepository(Project));
});
afterEach(() => ds.destroy());

async function seed(status: JobStatus, over: Partial<Job> = {}) {
    const p = await ds.getRepository(Project).save({ slug: 'p', name: 'P', maxAttempts: 3 });
    const r = await ds.getRepository(Repo).save({ projectId: p.id, fullName: 'a/b', testCommands: ['t'] });
    return ds.getRepository(Job).save(ds.getRepository(Job).create({
        projectId: p.id, repoId: r.id, title: 'T', task: 't', status, attempts: 1, prNumber: 5, branch: 'b', ...over,
    }));
}

describe('sendBack', () => {
    it.each(['pr_open', 'awaiting_review'] as const)('requeues a %s job with the reason', async (status) => {
        const job = await seed(status);
        expect(await service.sendBack(job, 'fix x')).toBe('queued');
        const after = await ds.getRepository(Job).findOneByOrFail({ id: job.id });
        expect(after).toMatchObject({ status: 'queued', lastReason: 'Sent back by the reviewer: fix x', prNumber: 5, branch: 'b' });
    });

    it('parks at max attempts', async () => {
        const job = await seed('awaiting_review', { attempts: 3 });
        expect(await service.sendBack(job, 'again')).toBe('parked');
    });

    it.each(['queued', 'dispatched', 'parked', 'merged'] as const)('409 for %s', async (status) => {
        await expect(service.sendBack(await seed(status), 'x')).rejects.toBeInstanceOf(ConflictException);
    });

    it('409 without a PR', async () => {
        await expect(service.sendBack(await seed('pr_open', { prNumber: null }), 'x')).rejects.toBeInstanceOf(ConflictException);
    });
});
