import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { J1, P1, memoryDb } from '../lesson/lesson.fixture.js';
import { Project } from '../project/project.entity.js';
import type { RepoManifestService } from '../repo/repo-manifest.service.js';
import { JobRun } from '../run/run.entity.js';
import { JobEventsService } from './job-events.service.js';
import { Job } from './job.entity.js';

let ds: DataSource;
let refreshQuietly: ReturnType<typeof vi.fn>;
let events: JobEventsService;

const job = (over: Partial<Job> = {}) =>
    ds.getRepository(Job).save({ id: J1, projectId: P1, repoId: 'r', title: 't', task: 't', queuedAt: new Date(), status: 'pr_open', ...over });

beforeEach(async () => {
    ds = await memoryDb();
    refreshQuietly = vi.fn().mockResolvedValue(undefined);
    events = new JobEventsService(
        ds.getRepository(Job), ds.getRepository(JobRun), ds.getRepository(Project), undefined,
        { refreshQuietly } as unknown as RepoManifestService,
    );
});
afterEach(() => ds.destroy());

describe('JobEventsService manifest hook', () => {
    it('refreshes the repo manifest when a PR is merged', async () => {
        await events.prClosed(await job(), 1, true);
        expect(refreshQuietly).toHaveBeenCalledWith('r');
    });

    it('does not refresh when a PR is closed without merge', async () => {
        await events.prClosed(await job(), 1, false);
        expect(refreshQuietly).not.toHaveBeenCalled();
    });
});
