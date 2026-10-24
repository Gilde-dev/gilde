import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Job } from '../job/job.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { Lesson } from './lesson.entity.js';
import { LessonMapper } from './lesson.mapper.js';
import { LessonService } from './lesson.service.js';
import { LessonSource } from './lesson-source.entity.js';
import { J1, J2, P1, P2, memoryDb } from './lesson.fixture.js';

let ds: DataSource;
let service: LessonService;
let n = 0;

const lesson = (over: Partial<Lesson> = {}) => ds.getRepository(Lesson).save({ projectId: P1, text: 't', ...over });
const source = (lessonId: string, jobId = J1) =>
    ds.getRepository(LessonSource).save({ lessonId, sourceKey: `retro:${++n}`, kind: 'retro', jobId, runId: String(n), excerpt: 'e' });

beforeEach(async () => {
    ds = await memoryDb();
    service = new LessonService(new LessonMapper(), ds.getRepository(Lesson), ds.getRepository(LessonSource), ds.getRepository(Job), ds.getRepository(Repo));
});
afterEach(() => ds.destroy());

describe('LessonService', () => {
    it('counts distinct jobs, not sources, and exposes the PR url', async () => {
        await ds.getRepository(Job).save({ id: J1, projectId: P1, repoId: 'r', title: 't', task: 't', queuedAt: new Date(), prUrl: 'https://github.com/o/r/pull/1' });
        const l = await lesson();
        await source(l.id, J1);
        await source(l.id, J1);
        await source(l.id, J2);
        const dto = await service.getById(l.id);
        expect(dto.sources).toHaveLength(3);
        expect(dto.sourceCount).toBe(2);
        expect(dto.sources.find((s) => s.jobId === J1)!.prUrl).toBe('https://github.com/o/r/pull/1');
        expect(dto.sources.find((s) => s.jobId === J2)!.prUrl).toBeNull();
    });

    it('lists filtered by project and status', async () => {
        await lesson();
        await lesson({ status: 'rejected' });
        await lesson({ projectId: P2 });
        expect(await service.list({})).toHaveLength(3);
        expect(await service.list({ projectId: P1 })).toHaveLength(2);
        expect(await service.list({ projectId: P1, status: 'rejected' })).toHaveLength(1);
    });

    it('approve without targetKind is a 400, with one it works', async () => {
        const l = await lesson();
        await expect(service.approve(l.id)).rejects.toBeInstanceOf(BadRequestException);
        await service.update(l.id, { targetKind: 'agents_md', note: 'n', text: 'new' });
        expect(await service.approve(l.id)).toMatchObject({ status: 'approved', targetKind: 'agents_md', note: 'n', text: 'new' });
    });

    it('follows the transition table and returns 409 otherwise', async () => {
        const l = await lesson({ targetKind: 'skill' });
        await expect(service.reopen(l.id)).rejects.toBeInstanceOf(ConflictException);
        await service.approve(l.id);
        await expect(service.approve(l.id)).rejects.toBeInstanceOf(ConflictException);
        expect((await service.reopen(l.id)).status).toBe('candidate');
        expect((await service.reject(l.id)).status).toBe('rejected');
        await expect(service.approve(l.id)).rejects.toBeInstanceOf(ConflictException);
        expect((await service.reopen(l.id)).status).toBe('candidate');
    });

    it('only accepts a target repo from the lesson\'s project', async () => {
        const l = await lesson();
        const repo = await ds.getRepository(Repo).save({ projectId: P2, fullName: 'o/r', testCommand: 't' });
        await expect(service.update(l.id, { targetRepoId: repo.id })).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.update(l.id, { targetRepoId: J1 })).rejects.toBeInstanceOf(BadRequestException);
        const own = await ds.getRepository(Repo).save({ projectId: P1, fullName: 'o/r2', testCommand: 't' });
        expect((await service.update(l.id, { targetRepoId: own.id })).targetRepoId).toBe(own.id);
        expect((await service.update(l.id, { targetRepoId: null })).targetRepoId).toBeNull();
    });

    it('404s on an unknown lesson', async () => {
        await expect(service.getById(J1)).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('merge', () => {
        it('moves the sources onto the target and deletes the merged lessons', async () => {
            const target = await lesson({ status: 'approved' });
            const a = await lesson();
            const b = await lesson();
            await source(target.id, J1);
            await source(a.id, J2);
            await source(b.id, J2);
            const dto = await service.merge({ targetId: target.id, lessonIds: [a.id, b.id] });
            expect(dto.id).toBe(target.id);
            expect(dto.sources).toHaveLength(3);
            expect(dto.sourceCount).toBe(2);
            expect(await ds.getRepository(Lesson).count()).toBe(1);
            expect(await ds.getRepository(LessonSource).count({ where: { lessonId: target.id } })).toBe(3);
        });

        it('409s across projects', async () => {
            const target = await lesson();
            const other = await lesson({ projectId: P2 });
            await expect(service.merge({ targetId: target.id, lessonIds: [other.id] })).rejects.toBeInstanceOf(ConflictException);
            expect(await ds.getRepository(Lesson).count()).toBe(2);
        });

        it('409s when the target or a merged lesson is rejected', async () => {
            const target = await lesson();
            const rejected = await lesson({ status: 'rejected' });
            await expect(service.merge({ targetId: target.id, lessonIds: [rejected.id] })).rejects.toBeInstanceOf(ConflictException);
            await expect(service.merge({ targetId: rejected.id, lessonIds: [target.id] })).rejects.toBeInstanceOf(ConflictException);
            expect(await ds.getRepository(Lesson).count()).toBe(2);
        });

        it('400s when the target is in lessonIds, 404s on unknown ids', async () => {
            const target = await lesson();
            await expect(service.merge({ targetId: target.id, lessonIds: [target.id] })).rejects.toBeInstanceOf(BadRequestException);
            await expect(service.merge({ targetId: target.id, lessonIds: [J1] })).rejects.toBeInstanceOf(NotFoundException);
        });
    });
});
