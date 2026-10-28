import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Job } from '../job/job.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { ReplaceLessonSchema } from './lesson.dto.js';
import { Lesson } from './lesson.entity.js';
import { LessonMapper } from './lesson.mapper.js';
import { LessonService } from './lesson.service.js';
import { LessonSource } from './lesson-source.entity.js';
import { J1, J2, P1, P2, memoryDb } from './lesson.fixture.js';
import type { JobService } from '../job/job.service.js';
import { Project } from '../project/project.entity.js';
import type { ProjectService } from '../project/project.service.js';
import type { SkillLibraryResolver } from '../skill/skill-library.resolver.js';

let ds: DataSource;
let service: LessonService;
let projectInfo: { skillsLibrary: string } | Error;
let libraryNames: string[] | Error;
const projects = { getById: async () => { if (projectInfo instanceof Error) throw projectInfo; return { id: P1, ...projectInfo }; } } as unknown as ProjectService;
const resolver = {
    resolve: async () => ({ library: { getCatalog: async () => { if (libraryNames instanceof Error) throw libraryNames; return libraryNames.map((name) => ({ name })); } } }),
} as unknown as SkillLibraryResolver;
let n = 0;

/** Stands in for JobService.create: saves a queued job on the repo. */
const fakeJobs = (db: DataSource) => ({
    create: vi.fn(async (repoId: string, dto: { title: string; task: string; acceptanceCriteria?: string[] }) => {
        const repo = await db.getRepository(Repo).findOneByOrFail({ id: repoId });
        return db.getRepository(Job).save({ ...dto, acceptanceCriteria: dto.acceptanceCriteria ?? [], repoId, projectId: repo.projectId, queuedAt: new Date() });
    }),
}) as unknown as JobService & { create: ReturnType<typeof vi.fn> };

const lesson = (over: Partial<Lesson> = {}) => ds.getRepository(Lesson).save({ projectId: P1, text: 't', ...over });
const source = (lessonId: string, jobId = J1) =>
    ds.getRepository(LessonSource).save({ lessonId, sourceKey: `retro:${++n}`, kind: 'retro', jobId, runId: String(n), excerpt: 'e' });

beforeEach(async () => {
    ds = await memoryDb();
    await ds.getRepository(Project).save([{ id: P1, slug: 'p1', name: 'p1' }, { id: P2, slug: 'p2', name: 'p2' }]);
    service = new LessonService(new LessonMapper(), ds.getRepository(Lesson), ds.getRepository(LessonSource), ds.getRepository(Job), ds.getRepository(Repo), fakeJobs(ds), projects, resolver);
    projectInfo = { skillsLibrary: 'none' };
    libraryNames = [];
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
        const l = await lesson({ targetKind: 'repo_skill' });
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
        const repo = await ds.getRepository(Repo).save({ projectId: P2, fullName: 'o/r', testCommands: ['t'] });
        await expect(service.update(l.id, { targetRepoId: repo.id })).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.update(l.id, { targetRepoId: J1 })).rejects.toBeInstanceOf(BadRequestException);
        const own = await ds.getRepository(Repo).save({ projectId: P1, fullName: 'o/r2', testCommands: ['t'] });
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

    describe('apply', () => {
        const approved = async (over: Partial<Lesson> = {}) => {
            const repo = await ds.getRepository(Repo).save({ projectId: P1, fullName: `o/r${++n}`, testCommands: ['t'] });
            return { repo, l: await lesson({ status: 'approved', targetKind: 'repo_skill', targetRepoId: repo.id, text: 'Always run pnpm install first', ...over }) };
        };

        it('passes the acting user on to the job', async () => {
            const { l } = await approved();
            await service.apply(l.id, { id: 'user-1' });
            expect((service as never as { jobService: { create: ReturnType<typeof vi.fn> } }).jobService.create.mock.calls[0][2]).toEqual({ id: 'user-1' });
        });

        it('creates one job on the target repo with the instruction and evidence, and moves the lesson to applying', async () => {
            const { repo, l } = await approved();
            await ds.getRepository(Job).save({ id: J1, projectId: P1, repoId: 'r', title: 't', task: 't', queuedAt: new Date(), prUrl: 'https://github.com/o/r/pull/1' });
            for (let i = 0; i < 6; i++) await ds.getRepository(LessonSource).save({ lessonId: l.id, sourceKey: `retro:e${i}`, kind: 'retro', jobId: J1, excerpt: `excerpt ${i}` });

            const dto = await service.apply(l.id);

            const created = await ds.getRepository(Job).find({ where: { repoId: repo.id } });
            expect(created).toHaveLength(1);
            expect(created[0].title).toBe('Apply lesson: Always run pnpm install first');
            expect(created[0].task).toContain('Always run pnpm install first');
            expect(created[0].task).toContain(l.id);
            expect(created[0].task).toContain('.claude/skills/<name>/');
            expect(created[0].task).toContain('no `managed-by` line');
            expect(created[0].task).toContain('Never edit a skill that has a `managed-by` line');
            expect(created[0].task).toContain('outcome blocked');
            expect(created[0].task).not.toContain('are taken');
            expect(created[0].task).toContain('https://github.com/o/r/pull/1');
            expect(created[0].task).toContain('outcome blocked');
            expect(created[0].task.match(/excerpt \d/g)).toHaveLength(5);
            expect(created[0].acceptanceCriteria.join('\n')).toContain(l.id);
            expect(dto).toMatchObject({ status: 'applying', appliedJobId: created[0].id, appliedAt: null });
        });

        it('lists the library skill names as taken, and skips the list without a library or when it cannot be read', async () => {
            projectInfo = { skillsLibrary: 'repo' };
            libraryNames = ['alpha', 'beta'];
            const first = await approved();
            await service.apply(first.l.id);
            expect((await ds.getRepository(Job).findOneByOrFail({ repoId: first.repo.id })).task).toContain('are taken, so do not use them for a new skill: alpha, beta');

            libraryNames = new Error('unreadable');
            const second = await approved();
            await service.apply(second.l.id);
            const task = (await ds.getRepository(Job).findOneByOrFail({ repoId: second.repo.id })).task;
            expect(task).not.toContain('are taken');
            expect(task).toContain('Verify the lesson');

            projectInfo = { skillsLibrary: 'none' };
            libraryNames = ['alpha'];
            const third = await approved();
            await service.apply(third.l.id);
            expect((await ds.getRepository(Job).findOneByOrFail({ repoId: third.repo.id })).task).not.toContain('are taken');
        });

        it('applies a legacy skill lesson exactly like repo_skill', async () => {
            const { repo, l } = await approved({ targetKind: 'skill' });
            await service.apply(l.id);
            expect((await ds.getRepository(Job).findOneByOrFail({ repoId: repo.id })).task).toContain('no `managed-by` line');
        });

        it('rejects setting or approving the legacy skill kind with 400', async () => {
            const l = await lesson();
            expect(ReplaceLessonSchema.safeParse({ text: 'x', targetKind: 'skill', targetRepoId: null, note: null }).success).toBe(false);
            expect(ReplaceLessonSchema.safeParse({ text: 'x', targetKind: 'repo_skill', targetRepoId: null, note: null }).success).toBe(true);
            await ds.getRepository(Lesson).update({ id: l.id }, { targetKind: 'skill' });
            await expect(service.approve(l.id)).rejects.toBeInstanceOf(BadRequestException);
        });

        it('truncates the title to 60 characters of text and uses the AGENTS.md instruction', async () => {
            const { repo, l } = await approved({ targetKind: 'agents_md', text: 'x'.repeat(100) });
            await service.apply(l.id);
            const job = await ds.getRepository(Job).findOneByOrFail({ repoId: repo.id });
            expect(job.title).toBe(`Apply lesson: ${'x'.repeat(60)}`);
            expect(job.task).toContain('Update AGENTS.md');
            expect(job.task).toContain('explicitly allows changing AGENTS.md');
        });

        it('409s unless the lesson is approved, creating no job', async () => {
            for (const status of ['candidate', 'rejected', 'applying', 'applied'] as const) {
                const { l } = await approved({ status });
                await expect(service.apply(l.id)).rejects.toBeInstanceOf(ConflictException);
            }
            expect(await ds.getRepository(Job).count()).toBe(0);
        });

        it('400s for other kinds, a missing repo and a repo of another project', async () => {
            for (const targetKind of ['routine_prompt', 'other', null] as const) {
                const { l } = await approved({ targetKind });
                await expect(service.apply(l.id)).rejects.toBeInstanceOf(BadRequestException);
            }
            const noRepo = await lesson({ status: 'approved', targetKind: 'repo_skill' });
            await expect(service.apply(noRepo.id)).rejects.toBeInstanceOf(BadRequestException);
            const foreign = await ds.getRepository(Repo).save({ projectId: P2, fullName: 'o/x', testCommands: ['t'] });
            const cross = await lesson({ status: 'approved', targetKind: 'repo_skill', targetRepoId: foreign.id });
            await expect(service.apply(cross.id)).rejects.toBeInstanceOf(BadRequestException);
            expect(await ds.getRepository(Job).count()).toBe(0);
        });
    });

    describe('markApplied', () => {
        it('moves approved lessons to applied with appliedAt', async () => {
            const l = await lesson({ status: 'approved', targetKind: 'other' });
            const dto = await service.markApplied(l.id);
            expect(dto.status).toBe('applied');
            expect(dto.appliedAt).not.toBeNull();
            expect(dto.appliedJobId).toBeNull();
        });

        it('409s from every other status, and applied is final', async () => {
            for (const status of ['candidate', 'rejected', 'applying', 'applied'] as const) {
                const l = await lesson({ status });
                await expect(service.markApplied(l.id)).rejects.toBeInstanceOf(ConflictException);
            }
            const l = await lesson({ status: 'approved', targetKind: 'other' });
            await service.markApplied(l.id);
            await expect(service.approve(l.id)).rejects.toBeInstanceOf(ConflictException);
            await expect(service.reject(l.id)).rejects.toBeInstanceOf(ConflictException);
            await expect(service.reopen(l.id)).rejects.toBeInstanceOf(ConflictException);
            await expect(service.apply(l.id)).rejects.toBeInstanceOf(ConflictException);
        });

        it('applying lessons cannot be merged', async () => {
            const a = await lesson({ status: 'approved' });
            const b = await lesson({ status: 'applying', appliedJobId: J1 });
            await expect(service.merge({ targetId: a.id, lessonIds: [b.id] })).rejects.toBeInstanceOf(ConflictException);
        });
    });

    describe('onJobEnded', () => {
        const applying = () => lesson({ status: 'applying', appliedJobId: J1, targetKind: 'skill', note: 'n' });

        it('merged -> applied with appliedAt', async () => {
            const l = await applying();
            await service.onJobEnded(J1, 'merged');
            expect(await service.getById(l.id)).toMatchObject({ status: 'applied', note: 'n' });
            expect((await service.getById(l.id)).appliedAt).not.toBeNull();
        });

        it.each(['rejected', 'parked', 'cancelled'] as const)('%s -> back to approved with the reason appended to the note', async (status) => {
            const l = await applying();
            await service.onJobEnded(J1, status, 'why');
            const dto = await service.getById(l.id);
            expect(dto.status).toBe('approved');
            expect(dto.note).toContain('n\n');
            expect(dto.note).toContain(`${status}: why`);
            expect(dto.appliedAt).toBeNull();
        });

        it('does nothing for unrelated jobs, other statuses and non-applying lessons', async () => {
            const l = await applying();
            const done = await lesson({ status: 'applied', appliedJobId: J2 });
            await service.onJobEnded(J2, 'merged');
            await service.onJobEnded(J2, 'cancelled');
            await service.onJobEnded(J1, 'pr_open');
            expect((await service.getById(l.id)).status).toBe('applying');
            expect((await service.getById(done.id)).status).toBe('applied');
            expect((await service.getById(done.id)).note).toBeNull();
        });
    });
});
