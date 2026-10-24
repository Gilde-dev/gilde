import { ConflictException } from '@nestjs/common';
import { QueryFailedError, type Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';

import { JobRun } from './run.entity.js';
import { RunMapper } from './run.mapper.js';
import { RunService } from './run.service.js';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const ids = { jobId: JOB_ID, projectId: '22222222-2222-4222-8222-222222222222', repoId: '33333333-3333-4333-8333-333333333333' };

function entity(attempt: number): JobRun {
    return Object.assign(new JobRun(), {
        id: `00000000-0000-4000-8000-00000000000${attempt}`,
        ...ids,
        attempt,
        status: 'firing',
        sessionId: null,
        sessionUrl: null,
        error: null,
        result: null,
        retro: null,
        ciConclusion: null,
        firedAt: null,
        finishedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
}

function setup() {
    const repo = {
        create: vi.fn((x: Partial<JobRun>) => Object.assign(entity(x.attempt ?? 1), x)),
        save: vi.fn((x: JobRun) => Promise.resolve(x)),
        find: vi.fn(),
        update: vi.fn(() => Promise.resolve()),
    };
    const service = new RunService(new RunMapper(), repo as unknown as Repository<JobRun>);
    return { repo, service };
}

describe('RunService', () => {
    it('creates a run in firing status', async () => {
        const { service, repo } = setup();
        const run = await service.create({ ...ids, attempt: 1 });
        expect(run).toMatchObject({ ...ids, attempt: 1, status: 'firing', firedAt: null });
        expect(repo.save).toHaveBeenCalledOnce();
    });

    it('maps a duplicate (jobId, attempt) to a conflict', async () => {
        const { service, repo } = setup();
        repo.save.mockRejectedValue(new QueryFailedError('insert', [], Object.assign(new Error('dup'), { code: 'SQLITE_CONSTRAINT_UNIQUE' })));
        await expect(service.create({ ...ids, attempt: 1 })).rejects.toBeInstanceOf(ConflictException);
    });

    it('rethrows other errors', async () => {
        const { service, repo } = setup();
        repo.save.mockRejectedValue(new Error('boom'));
        await expect(service.create({ ...ids, attempt: 1 })).rejects.toThrow('boom');
    });

    it('lists runs for a job ordered by attempt', async () => {
        const { service, repo } = setup();
        repo.find.mockResolvedValue([entity(1), entity(2)]);
        const runs = await service.listForJob(JOB_ID);
        expect(repo.find).toHaveBeenCalledWith({ where: { jobId: JOB_ID }, order: { attempt: 'ASC' } });
        expect(runs.map((r) => r.attempt)).toEqual([1, 2]);
    });

    it('marks a run fired with its session', async () => {
        const { service, repo } = setup();
        await service.markFired('run-1', { sessionId: 's1', sessionUrl: 'https://x/s1' });
        expect(repo.update).toHaveBeenCalledWith(
            { id: 'run-1' },
            expect.objectContaining({ status: 'fired', sessionId: 's1', sessionUrl: 'https://x/s1', firedAt: expect.any(Date) }),
        );
    });

    it('marks a run fire_failed with the error', async () => {
        const { service, repo } = setup();
        await service.markFailed('run-1', 'nope');
        expect(repo.update).toHaveBeenCalledWith(
            { id: 'run-1' },
            expect.objectContaining({ status: 'fire_failed', error: 'nope', finishedAt: expect.any(Date) }),
        );
    });
});
