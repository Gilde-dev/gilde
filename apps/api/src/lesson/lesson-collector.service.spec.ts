import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Feedback } from '../feedback/feedback.entity.js';
import { JobRun } from '../run/run.entity.js';
import { Lesson } from './lesson.entity.js';
import { LessonCollectorService } from './lesson-collector.service.js';
import { LessonSource } from './lesson-source.entity.js';
import { J2, addFeedback, addRun, memoryDb } from './lesson.fixture.js';

let ds: DataSource;
let collector: LessonCollectorService;

beforeEach(async () => {
    ds = await memoryDb();
    collector = new LessonCollectorService(ds.getRepository(JobRun), ds.getRepository(Feedback), ds.getRepository(Lesson), ds.getRepository(LessonSource));
});
afterEach(() => ds.destroy());

describe('LessonCollectorService.collect', () => {
    it('creates a candidate lesson from a suggestedLesson, a retro and member feedback', async () => {
        const run = await addRun(ds, { result: { outcome: 'done', summary: 's', suggestedLesson: ' Document the test command ' }, retro: 'x'.repeat(5000) });
        const fb = await addFeedback(ds, { authorAssociation: 'MEMBER', body: 'Use the helper', jobId: J2 });

        expect(await collector.collect()).toEqual({ created: 3 });

        const lessons = await ds.getRepository(Lesson).find();
        expect(lessons.every((l) => l.status === 'candidate')).toBe(true);
        const sources = await ds.getRepository(LessonSource).find();
        expect(sources).toHaveLength(3);
        const byKind = Object.fromEntries(sources.map((s) => [s.kind, s]));
        expect(byKind.suggested_lesson).toMatchObject({ runId: run.id, jobId: run.jobId, excerpt: 'Document the test command' });
        expect(byKind.retro.excerpt).toHaveLength(4000);
        expect(byKind.feedback).toMatchObject({ feedbackId: fb.id, jobId: J2, runId: null });
        const text = (id: string) => lessons.find((l) => l.id === id)!.text;
        expect(text(byKind.suggested_lesson.lessonId)).toBe('Document the test command');
        expect(text(byKind.retro.lessonId)).toHaveLength(200);
        expect(text(byKind.feedback.lessonId)).toBe('Use the helper');
    });

    it('accepts OWNER and COLLABORATOR feedback too', async () => {
        await addFeedback(ds, { authorAssociation: 'OWNER' });
        await addFeedback(ds, { authorAssociation: 'COLLABORATOR' });
        expect(await collector.collect()).toEqual({ created: 2 });
    });

    it('ignores empty values and non-member feedback', async () => {
        await addRun(ds, { result: { outcome: 'done', summary: 's', suggestedLesson: '  ' }, retro: '   ' });
        await addRun(ds, { result: { outcome: 'done', summary: 's', suggestedLesson: null }, retro: null });
        await addRun(ds, { result: null });
        await addFeedback(ds, { body: '  ' });
        await addFeedback(ds, { authorAssociation: 'NONE' });
        await addFeedback(ds, { authorAssociation: 'CONTRIBUTOR' });
        expect(await collector.collect()).toEqual({ created: 0 });
        expect(await ds.getRepository(Lesson).count()).toBe(0);
    });

    it('creates nothing new when run twice, but picks up new sources', async () => {
        await addRun(ds, { retro: 'r' });
        await addFeedback(ds);
        expect(await collector.collect()).toEqual({ created: 2 });
        expect(await collector.collect()).toEqual({ created: 0 });
        await addFeedback(ds, { body: 'another' });
        expect(await collector.collect()).toEqual({ created: 1 });
        expect(await ds.getRepository(Lesson).count()).toBe(3);
    });

    it('does not recollect a source that was merged into another lesson', async () => {
        await addRun(ds, { retro: 'r' });
        await addFeedback(ds);
        await collector.collect();
        const [keep, gone] = await ds.getRepository(Lesson).find();
        await ds.getRepository(LessonSource).update({ lessonId: gone.id }, { lessonId: keep.id });
        await ds.getRepository(Lesson).delete({ id: gone.id });
        expect(await collector.collect()).toEqual({ created: 0 });
    });

    it('the database refuses a duplicate source', async () => {
        await addRun(ds, { retro: 'r' });
        await collector.collect();
        const { lessonId, sourceKey, kind, jobId, excerpt } = (await ds.getRepository(LessonSource).find())[0];
        await expect(ds.getRepository(LessonSource).save({ lessonId, sourceKey, kind, jobId, excerpt })).rejects.toThrow();
    });
});
