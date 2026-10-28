import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import type { AuthUser } from '../auth/auth.dto.js';
import { Job } from '../job/job.entity.js';
import { JobService } from '../job/job.service.js';
import { ProjectService } from '../project/project.service.js';
import { RepoService } from '../repo/repo.service.js';
import { SkillLibraryResolver } from '../skill/skill-library.resolver.js';
import { UserService } from '../user/user.service.js';

import { LESSON_PATTERN_MIN_SIZE, type ProposeSkillDto, type ProposeSkillResponseDto } from './lesson.dto.js';
import { Lesson } from './lesson.entity.js';
import { LessonPatternService } from './lesson-pattern.service.js';
import { proposalCriteria, proposalTask, proposalTitle } from './lesson-skill-proposal.js';
import { nextLessonStatus } from './lesson-state.js';

/**
 * Turns a lesson pattern into a triage job in the project's skills library repo. The job and the move of every lesson of the
 * pattern to `applying` are one transaction; nothing is queued. The existing `onJobEnded` finishes the lessons.
 */
@Injectable()
export class LessonSkillProposalService {
    constructor(
        @InjectRepository(Lesson) private readonly lessons: Repository<Lesson>,
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        private readonly patterns: LessonPatternService,
        private readonly projects: ProjectService,
        private readonly repos: RepoService,
        private readonly jobService: JobService,
        private readonly users: UserService,
        private readonly libraryResolver: SkillLibraryResolver,
    ) { }

    async propose(projectId: string, patternId: string, dto: ProposeSkillDto, user: AuthUser | null | undefined): Promise<ProposeSkillResponseDto> {
        const human = await this.users.requireVerifiedHuman(user ?? undefined);
        const project = await this.projects.getById(projectId);
        if (project.skillsLibrary !== 'repo' || !project.skillsLibraryRepoId) {
            throw new ConflictException('This project has no repo-backed skills library to propose a skill to');
        }
        const libraryRepo = await this.repos.getById(project.skillsLibraryRepoId);

        let taken: string[];
        try {
            const { library } = await this.libraryResolver.resolve(project);
            taken = (await library.getCatalog()).map((s) => s.name);
        } catch {
            throw new ServiceUnavailableException('The skills library could not be read, so the skill name cannot be checked');
        }
        if (taken.includes(dto.name)) throw new ConflictException(`The library already has a skill named '${dto.name}'`);
        if (await this.lessons.existsBy({ projectId, status: 'applying', appliedSkillName: dto.name })) {
            throw new ConflictException(`A proposal for a skill named '${dto.name}' is already in progress`);
        }

        const pattern = (await this.patterns.list(projectId, { minSize: LESSON_PATTERN_MIN_SIZE })).patterns.find((p) => p.id === patternId);
        if (!pattern) throw new ConflictException('This pattern changed or no longer exists; reload the patterns and try again');
        for (const m of pattern.members) {
            if (nextLessonStatus(m.status, 'approve') === null && nextLessonStatus(m.status, 'apply') === null) {
                throw new ConflictException(`Lesson ${m.lessonId} is ${m.status}`);
            }
        }

        const jobIds = [...new Set(pattern.members.flatMap((m) => m.sources.map((s) => s.jobId)))];
        const prUrls = new Map((jobIds.length ? await this.jobs.find({ where: { id: In(jobIds) }, select: { id: true, prUrl: true } }) : []).map((j) => [j.id, j.prUrl]));
        const repoNames = new Map((await this.repos.listForProject(projectId)).map((r) => [r.id, r.fullName]));
        const task = proposalTask(pattern, dto, { projectId, repoNames, taken, testCommands: libraryRepo.testCommands, prUrls });

        const jobId = await this.lessons.manager.transaction(async (m) => {
            const job = await this.jobService.create(libraryRepo.id, {
                title: proposalTitle(dto),
                task,
                acceptanceCriteria: proposalCriteria(dto),
                status: 'triage',
            }, human, m);
            for (const member of pattern.members) {
                // candidate -> approved -> applying, through the state machine, conditional on the status we read.
                const approved = member.status === 'candidate' ? nextLessonStatus('candidate', 'approve') : member.status;
                const applying = approved && nextLessonStatus(approved, 'apply');
                if (!applying) throw new ConflictException(`Lesson ${member.lessonId} is ${member.status}`);
                const res = await m.update(Lesson, { id: member.lessonId, status: member.status }, {
                    status: applying,
                    targetKind: 'library_skill',
                    targetRepoId: libraryRepo.id,
                    appliedJobId: job.id,
                    appliedSkillName: dto.name,
                    appliedAt: null,
                });
                if (res.affected !== 1) throw new ConflictException('A lesson changed in the meantime, reload the patterns and try again');
            }
            return job.id;
        });
        return { jobId, skillName: dto.name, lessonIds: pattern.members.map((m) => m.lessonId) };
    }
}
