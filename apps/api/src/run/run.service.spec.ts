import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';

import type { CreateRunDto } from './run.dto.js';
import type { JobRun } from './run.entity.js';
import { RunMapper } from './run.mapper.js';
import { RunService } from './run.service.js';

const ID = '11111111-1111-4111-8111-111111111111';
const dto: CreateRunDto = { jobId: ID, projectId: ID, repoId: ID, attempt: 1 };

function entity(over: Partial<JobRun> = {}): JobRun {
    return {
        id: ID, jobId: ID, projectId: ID, repoId: ID, attempt: 1, status: 'firing',
        sessionId: null, sessionUrl: null, error: null, firedAt: null, finishedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...over,
    };
}

function setup() {
    const repo = {
        create: vi.fn((x: Partial<JobRun>) => x),
        save: vi.fn(async (x: Partial<JobRun>) => entity(x)),
        find: vi.fn(async () => [] as JobRun[]),
    };
    const service = new RunService(new RunMapper(), repo as never);
    return { repo, service };
}

describe('RunService', () => {
    it('creates a run and returns a DTO', async () => {
        const { service, repo } = setup();
        const run = await service.create({ ...dto, status: 'fired', firedAt: '2026-01-01T00:00:00.000Z' });
        expect(repo.save).toHaveBeenCalled();
        expect(run.status).toBe('fired');
        expect(run.firedAt).toBe('2026-01-01T00:00:00.000Z');
        expect(run.finishedAt).toBeNull();
    });

    it('maps a duplicate (jobId, attempt) to a ConflictException', async () => {
        const { service, repo } = setup();
        const err = new QueryFailedError('insert', [], Object.assign(new Error('dup'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }));
        repo.save.mockRejectedValueOnce(err);
        await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
    });

    it('rethrows other errors', async () => {
        const { service, repo } = setup();
        repo.save.mockRejectedValueOnce(new Error('boom'));
        await expect(service.create(dto)).rejects.toThrow('boom');
    });

    it('lists runs for a job ordered by attempt', async () => {
        const { service, repo } = setup();
        repo.find.mockResolvedValueOnce([entity({ attempt: 1 }), entity({ attempt: 2 })]);
        const runs = await service.listForJob(ID);
        expect(repo.find).toHaveBeenCalledWith({ where: { jobId: ID }, order: { attempt: 'ASC' } });
        expect(runs.map((r) => r.attempt)).toEqual([1, 2]);
    });
});
