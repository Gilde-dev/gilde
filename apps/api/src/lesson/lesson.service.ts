import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, type FindOptionsWhere } from 'typeorm';

import { Job } from '../job/job.entity.js';
import type { JobStatus } from '../job/job-state.js';
import { JobService } from '../job/job.service.js';
import { ProjectService } from '../project/project.service.js';
import { Repo } from '../repo/repo.entity.js';
import { SkillLibraryResolver } from '../skill/skill-library.resolver.js';
import type { LessonResponseDto, ListLessonsQuery, MergeLessonsDto, UpdateLessonDto } from './lesson.dto.js';
import { Lesson } from './lesson.entity.js';
import { LessonMapper } from './lesson.mapper.js';
import { LessonSource } from './lesson-source.entity.js';
import type { LessonJobHook } from './lesson-hook.js';
import { nextLessonStatus, type LessonEvent } from './lesson-state.js';

@Injectable()
export class LessonService implements LessonJobHook {

    constructor(
        private readonly lessonMapper: LessonMapper,
        @InjectRepository(Lesson) private readonly lessons: Repository<Lesson>,
        @InjectRepository(LessonSource) private readonly sources: Repository<LessonSource>,
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @InjectRepository(Repo) private readonly repos: Repository<Repo>,
        private readonly jobService: JobService,
        private readonly projects: ProjectService,
        private readonly libraryResolver: SkillLibraryResolver,
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

    /** Creates a job on the target repo that applies the lesson; the lesson is `applying` until that job ends. */
    async apply(id: string): Promise<LessonResponseDto> {
        const lesson = await this.getOrFail(id);
        if (nextLessonStatus(lesson.status, 'apply') === null) throw new ConflictException(`Cannot apply a ${lesson.status} lesson`);
        if (lesson.targetKind !== 'repo_skill' && lesson.targetKind !== 'skill' && lesson.targetKind !== 'agents_md') {
            throw new BadRequestException('Only repo_skill and agents_md lessons can be applied as a job; use mark-applied for the rest');
        }
        if (!lesson.targetRepoId) throw new BadRequestException('targetRepoId is required to apply a lesson');
        const repo = await this.repos.findOneBy({ id: lesson.targetRepoId });
        if (!repo || repo.projectId !== lesson.projectId) {
            throw new BadRequestException(`Repo ${lesson.targetRepoId} is not in the lesson's project`);
        }

        const sources = await this.sources.find({ where: { lessonId: id }, order: { createdAt: 'ASC' }, take: MAX_EVIDENCE });
        const prUrls = await this.prUrls(sources.map((s) => s.jobId));
        const job = await this.jobService.create(repo.id, {
            title: `Apply lesson: ${lesson.text.slice(0, 60)}`,
            task: applyTask(lesson, sources, prUrls, lesson.targetKind === 'agents_md' ? null : await this.libraryNames(lesson.projectId)),
            acceptanceCriteria: [
                'The change is minimal and consistent with the existing content',
                `The PR body cites the lesson id ${lesson.id}`,
            ],
        });

        const res = await this.lessons.update({ id, status: 'approved' }, { status: 'applying', appliedJobId: job.id, appliedAt: null });
        if (res.affected !== 1) throw new ConflictException('Lesson changed in the meantime, try again');
        return this.getById(id);
    }

    /** For lessons applied by hand. */
    async markApplied(id: string): Promise<LessonResponseDto> {
        const lesson = await this.getOrFail(id);
        const next = nextLessonStatus(lesson.status, 'mark_applied');
        if (!next) throw new ConflictException(`Cannot mark a ${lesson.status} lesson as applied`);
        lesson.status = next;
        lesson.appliedAt = new Date();
        await this.lessons.save(lesson);
        return this.getById(id);
    }

    /** A job reached an end state: finish the lesson it was applying, if any. No-op for other jobs and statuses. */
    async onJobEnded(jobId: string, status: JobStatus, reason?: string): Promise<void> {
        const lesson = await this.lessons.findOneBy({ appliedJobId: jobId, status: 'applying' });
        if (!lesson) return;
        if (status === 'merged') {
            lesson.status = nextLessonStatus('applying', 'job_merged')!;
            lesson.appliedAt = new Date();
        } else if (status === 'rejected' || status === 'parked' || status === 'cancelled') {
            lesson.status = nextLessonStatus('applying', 'job_failed')!;
            const why = `Apply job ${jobId} ${status}${reason ? `: ${reason}` : ''}`;
            lesson.note = lesson.note ? `${lesson.note}\n${why}` : why;
        } else {
            return;
        }
        await this.lessons.save(lesson);
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
            if (l.status === 'applying' || l.status === 'applied') throw new ConflictException(`Lesson ${l.id} is ${l.status}`);
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
        if (event === 'approve' && lesson.targetKind === 'skill') {
            throw new BadRequestException("targetKind 'skill' is no longer supported; use repo_skill");
        }
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
        const prUrls = await this.prUrls([...sources.map((s) => s.jobId), ...lessons.flatMap((l) => (l.appliedJobId ? [l.appliedJobId] : []))]);
        return lessons.map((l) => this.lessonMapper.toDTO(
            l,
            sources.filter((s) => s.lessonId === l.id).map((s) => this.lessonMapper.toSourceDTO(s, prUrls.get(s.jobId) ?? null)),
            l.appliedJobId ? prUrls.get(l.appliedJobId) ?? null : null,
        ));
    }

    /** Names in the project's skills library, or null when there is no library or it cannot be read. */
    private async libraryNames(projectId: string): Promise<string[] | null> {
        try {
            const project = await this.projects.getById(projectId);
            if (project.skillsLibrary === 'none') return null;
            const { library } = await this.libraryResolver.resolve(project);
            return (await library.getCatalog()).map((s) => s.name);
        } catch {
            return null;
        }
    }

    private async prUrls(jobIds: string[]): Promise<Map<string, string | null>> {
        const jobs = await this.jobs.find({ where: { id: In([...new Set(jobIds)]) }, select: { id: true, prUrl: true } });
        return new Map(jobs.map((j) => [j.id, j.prUrl]));
    }
}

const MAX_EVIDENCE = 5;

const AGENTS_MD_INSTRUCTION = 'Update AGENTS.md with the smallest change that captures the lesson. This task explicitly allows changing AGENTS.md.';

function repoSkillInstruction(taken: string[] | null): string {
    return [
        'Add or update a repo-owned skill under `.claude/skills/<name>/` with a `SKILL.md` whose frontmatter has `name` (equal to the folder name) and `description`, and no `managed-by` line.',
        'This task explicitly allows changing that one skill folder under `.claude/skills/`, and nothing else there.',
        'Never edit a skill that has a `managed-by` line. If the lesson belongs in such a managed skill, report outcome blocked and say so: that skill must change in the library.',
        taken?.length && `These names belong to library skills and are taken, so do not use them for a new skill: ${taken.join(', ')}.`,
    ].filter(Boolean).join(' ');
}

function applyTask(lesson: Lesson, sources: LessonSource[], prUrls: Map<string, string | null>, taken: string[] | null): string {
    const evidence = sources
        .map((s) => `- "${s.excerpt}" (${prUrls.get(s.jobId) ?? 'no PR'})`)
        .join('\n');
    return [
        `Lesson (id ${lesson.id}):`,
        lesson.text,
        lesson.targetKind === 'agents_md' ? AGENTS_MD_INSTRUCTION : repoSkillInstruction(taken),
        evidence && `Evidence from earlier jobs:\n${evidence}`,
        'Verify the lesson against the current code first. If it does not hold or is already covered, report outcome blocked and explain instead of changing anything.',
    ].filter(Boolean).join('\n\n');
}
