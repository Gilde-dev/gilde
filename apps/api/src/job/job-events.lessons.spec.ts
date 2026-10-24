import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Lesson } from '../lesson/lesson.entity.js';
import { LessonMapper } from '../lesson/lesson.mapper.js';
import { LessonService } from '../lesson/lesson.service.js';
import { LessonSource } from '../lesson/lesson-source.entity.js';
import { J1, J2, P1, memoryDb } from '../lesson/lesson.fixture.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { JobEventsService } from './job-events.service.js';
import { Job } from './job.entity.js';
import type { JobService } from './job.service.js';

let ds: DataSource;
let events: JobEventsService;

const job = (id: string, over: Partial<Job> = {}) =>
    ds.getRepository(Job).save({ id, projectId: P1, repoId: 'r', title: 't', task: 't', queuedAt: new Date(), status: 'pr_open', ...over });
const lesson = (over: Partial<Lesson> = {}) =>
    ds.getRepository(Lesson).save({ projectId: P1, text: 't', status: 'applying', appliedJobId: J1, targetKind: 'skill', ...over });

beforeEach(async () => {
    ds = await memoryDb();
    const lessons = new LessonService(
        new LessonMapper(), ds.getRepository(Lesson), ds.getRepository(LessonSource), ds.getRepository(Job), ds.getRepository(Repo), {} as JobService,
    );
    events = new JobEventsService(ds.getRepository(Job), ds.getRepository(JobRun), ds.getRepository(Project), lessons);
});
afterEach(() => ds.destroy());

describe('JobEventsService lesson hook', () => {
    it('a merged PR applies the lesson', async () => {
        const l = await lesson();
        await events.prClosed(await job(J1), 1, true);
        const after = await ds.getRepository(Lesson).findOneByOrFail({ id: l.id });
        expect(after.status).toBe('applied');
        expect(after.appliedAt).not.toBeNull();
    });

    it('a PR closed without merge sends the lesson back to approved with a note', async () => {
        const l = await lesson();
        await events.prClosed(await job(J1), 1, false);
        const after = await ds.getRepository(Lesson).findOneByOrFail({ id: l.id });
        expect(after.status).toBe('approved');
        expect(after.note).toContain('rejected');
    });

    it('a parked job sends the lesson back to approved with the reason', async () => {
        const l = await lesson();
        await ds.getRepository(Project).save({ id: P1, slug: 's', name: 'n', maxAttempts: 1 } as Partial<Project>);
        await events.retryOrParkJob(await job(J1, { attempts: 1 }), 'CI failed');
        const after = await ds.getRepository(Lesson).findOneByOrFail({ id: l.id });
        expect(after.status).toBe('approved');
        expect(after.note).toContain('parked: CI failed');
    });

    it('a retry keeps the lesson applying', async () => {
        const l = await lesson();
        await ds.getRepository(Project).save({ id: P1, slug: 's', name: 'n', maxAttempts: 3 } as Partial<Project>);
        await events.retryOrParkJob(await job(J1, { attempts: 1 }), 'CI failed');
        expect((await ds.getRepository(Lesson).findOneByOrFail({ id: l.id })).status).toBe('applying');
    });

    it('does nothing for jobs without a lesson', async () => {
        const l = await lesson();
        await events.prClosed(await job(J2), 1, true);
        expect((await ds.getRepository(Lesson).findOneByOrFail({ id: l.id })).status).toBe('applying');
    });
});
