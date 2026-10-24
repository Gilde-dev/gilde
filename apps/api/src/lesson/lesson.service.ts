import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, type FindOptionsWhere } from 'typeorm';

import { Job } from '../job/job.entity.js';
import { Repo } from '../repo/repo.entity.js';
import type { LessonResponseDto, ListLessonsQuery, MergeLessonsDto, UpdateLessonDto } from './lesson.dto.js';
import { Lesson } from './lesson.entity.js';
import { LessonMapper } from './lesson.mapper.js';
import { LessonSource } from './lesson-source.entity.js';
import { nextLessonStatus, type LessonEvent } from './lesson-state.js';

@Injectable()
export class LessonService {

    constructor(
        private readonly lessonMapper: LessonMapper,
        @InjectRepository(Lesson) private readonly lessons: Repository<Lesson>,
        @InjectRepository(LessonSource) private readonly sources: Repository<LessonSource>,
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @InjectRepository(Repo) private readonly repos: Repository<Repo>,
    ) { }

    async list(q: ListLessonsQuery): Promise<LessonResponseDto[]> {
        const where: FindOptionsWhere<Lesson> = {};
        if (q.projectId) where.projectId = q.projectId;
        if (q.status) where.status = q.status;
        return this.toDTOs(await this.lessons.find({ where, order: { createdAt: 'DESC' } }));
    }

    async getById(id: string): Promise<LessonResponseDto> {
        return (await this.toDTOs([await this.getOrFail(id)]))[0];
    }

    async update(id: string, dto: UpdateLessonDto): Promise<LessonResponseDto> {
        const lesson = await this.getOrFail(id);
        if (dto.targetRepoId) {
            const repo = await this.repos.findOneBy({ id: dto.targetRepoId });
            if (!repo || repo.projectId !== lesson.projectId) {
                throw new BadRequestException(`Repo ${dto.targetRepoId} is not in the lesson's project`);
            }
        }
        await this.lessons.save(Object.assign(lesson, dto));
        return this.getById(id);
    }

    approve(id: string): Promise<LessonResponseDto> {
        return this.transition(id, 'approve');
    }

    reject(id: string): Promise<LessonResponseDto> {
        return this.transition(id, 'reject');
    }

    reopen(id: string): Promise<LessonResponseDto> {
        return this.transition(id, 'reopen');
    }

    /** Moves the sources of `lessonIds` onto `targetId` and deletes those lessons. */
    async merge(dto: MergeLessonsDto): Promise<LessonResponseDto> {
        const ids = [...new Set(dto.lessonIds)];
        if (ids.includes(dto.targetId)) throw new BadRequestException('targetId must not be in lessonIds');
        const target = await this.getOrFail(dto.targetId);
        const merged = await this.lessons.findBy({ id: In(ids) });
        if (merged.length !== ids.length) throw new NotFoundException('One or more lessons not found');
        for (const l of [target, ...merged]) {
            if (l.projectId !== target.projectId) throw new ConflictException('Lessons belong to different projects');
            if (l.status === 'rejected') throw new ConflictException(`Lesson ${l.id} is rejected`);
        }
        await this.lessons.manager.transaction(async (m) => {
            await m.update(LessonSource, { lessonId: In(ids) }, { lessonId: target.id });
            await m.delete(Lesson, { id: In(ids) });
            await m.update(Lesson, { id: target.id }, { updatedAt: new Date() });
        });
        return this.getById(target.id);
    }

    private async transition(id: string, event: LessonEvent): Promise<LessonResponseDto> {
        const lesson = await this.getOrFail(id);
        const next = nextLessonStatus(lesson.status, event);
        if (!next) throw new ConflictException(`Cannot ${event} a ${lesson.status} lesson`);
        if (event === 'approve' && !lesson.targetKind) throw new BadRequestException('targetKind is required to approve a lesson');
        lesson.status = next;
        await this.lessons.save(lesson);
        return this.getById(id);
    }

    private async getOrFail(id: string): Promise<Lesson> {
        const lesson = await this.lessons.findOneBy({ id });
        if (!lesson) throw new NotFoundException(`Lesson ${id} not found`);
        return lesson;
    }

    private async toDTOs(lessons: Lesson[]): Promise<LessonResponseDto[]> {
        if (lessons.length === 0) return [];
        const sources = await this.sources.find({ where: { lessonId: In(lessons.map((l) => l.id)) }, order: { createdAt: 'ASC' } });
        const jobs = await this.jobs.find({ where: { id: In([...new Set(sources.map((s) => s.jobId))]) }, select: { id: true, prUrl: true } });
        const prUrls = new Map(jobs.map((j) => [j.id, j.prUrl]));
        return lessons.map((l) => this.lessonMapper.toDTO(
            l,
            sources.filter((s) => s.lessonId === l.id).map((s) => this.lessonMapper.toSourceDTO(s, prUrls.get(s.jobId) ?? null)),
        ));
    }
}
