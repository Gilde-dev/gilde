import { DataSource } from 'typeorm';

import { Feedback } from '../feedback/feedback.entity.js';
import { Job } from '../job/job.entity.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { User } from '../user/user.entity.js';
import { JobRun } from '../run/run.entity.js';
import { Lesson } from './lesson.entity.js';
import { LessonSource } from './lesson-source.entity.js';

export const ENTITIES = [User, Lesson, LessonSource, JobRun, Feedback, Job, Repo, Project];

export const P1 = '11111111-1111-4111-8111-111111111111';
export const P2 = '22222222-2222-4222-8222-222222222222';
export const J1 = '55555555-5555-4555-8555-555555555555';
export const J2 = '66666666-6666-4666-8666-666666666666';

export function memoryDb(): Promise<DataSource> {
    return new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: ENTITIES, synchronize: true }).initialize();
}

let n = 0;
export const addRun = (ds: DataSource, over: Partial<JobRun> = {}) =>
    ds.getRepository(JobRun).save({ jobId: J1, projectId: P1, repoId: 'r', attempt: ++n, ...over });

export const addFeedback = (ds: DataSource, over: Partial<Feedback> = {}) =>
    ds.getRepository(Feedback).save({
        jobId: J1, projectId: P1, repoId: 'r', prNumber: 1, kind: 'comment', githubId: String(++n), author: 'a',
        authorAssociation: 'OWNER', body: 'Please add tests', url: 'u', ...over,
    });
