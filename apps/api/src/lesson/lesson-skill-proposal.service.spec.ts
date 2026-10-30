import { ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Feature } from '../feature/feature.entity.js';
import { JobDependency } from '../job/job-dependency.entity.js';
import { Job } from '../job/job.entity.js';
import { JobMapper } from '../job/job.mapper.js';
import { JobService } from '../job/job.service.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRevision } from '../revision/revision.entity.js';
import { User } from '../user/user.entity.js';

import type { LessonPatternDto } from './lesson.dto.js';
import { Lesson } from './lesson.entity.js';
import { LessonMapper } from './lesson.mapper.js';
import { LessonService } from './lesson.service.js';
import { LessonSkillProposalService } from './lesson-skill-proposal.service.js';
import { LessonSource } from './lesson-source.entity.js';
import type { LessonStatus } from './lesson-state.js';

const HUMAN = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', credential: 'jwt' } as never;

describe('LessonSkillProposalService', () => {
    let ds: DataSource;
    let project: Project;
    let library: Repo;
    let source: Repo;
    let pattern: LessonPatternDto;
    let catalog: string[];
    let service: LessonSkillProposalService;

    const lessons = () => ds.getRepository(Lesson);
    const jobs = () => ds.getRepository(Job);
    const lesson = (text: string, status: LessonStatus) => lessons().save({ projectId: project.id, text, status, targetKind: status === 'approved' ? 'repo_skill' : null });

    async function patternOf(members: Lesson[]): Promise<LessonPatternDto> {
        return {
            id: 'pat', representativeText: members[0].text, size: members.length,
            members: members.map((m) => ({ lessonId: m.id, text: m.text, status: m.status, sources: [] })),
            jobIds: [], runIds: [], repoIds: [source.id], firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), alreadyCovered: [],
        };
    }

    beforeEach(async () => {
        ds = await new DataSource({
            type: 'better-sqlite3', database: ':memory:', synchronize: true,
            entities: [User, Project, Repo, Job, JobDependency, Feature, JobRevision, Lesson, LessonSource],
        }).initialize();
        await ds.getRepository(User).insert({ id: HUMAN.id, name: 'H', email: 'h@example.com', password: 'x' });
        const projects = ds.getRepository(Project);
        project = await projects.save(projects.create({ slug: 'p', name: 'P' }));
        const repos = ds.getRepository(Repo);
        library = await repos.save(repos.create({ projectId: project.id, fullName: 'o/library', testCommands: ['pnpm validate'] }));
        source = await repos.save(repos.create({ projectId: project.id, fullName: 'o/app', testCommands: ['x'] }));
        await projects.update({ id: project.id }, { skillsLibrary: 'repo', skillsLibraryRepoId: library.id });
        catalog = ['existing'];
        const a = await lesson('Run pnpm install first', 'candidate');
        const b = await lesson('Always run pnpm install first', 'approved');
        pattern = await patternOf([a, b]);
        service = build();
    });
    afterEach(() => ds.destroy());

    function build(over: { patterns?: unknown; users?: unknown } = {}) {
        const repoDto = (r: Repo) => ({ id: r.id, projectId: r.projectId, fullName: r.fullName, testCommands: r.testCommands });
        const repoService = {
            getById: async (id: string) => repoDto(await ds.getRepository(Repo).findOneByOrFail({ id })),
            listForProject: async () => (await ds.getRepository(Repo).find()).map(repoDto),
        };
        const jobService = new JobService(new JobMapper(), repoService as never, { latestOperatorActions: async () => new Map() } as never, {} as never, jobs(), ds.getRepository(JobDependency), ds.getRepository(Feature));
        return new LessonSkillProposalService(
            lessons(), jobs(),
            (over.patterns ?? { list: async () => ({ patterns: [pattern] }) }) as never,
            { getById: async (id: string) => ds.getRepository(Project).findOneByOrFail({ id }) } as never,
            repoService as never, jobService,
            (over.users ?? { requireVerifiedHuman: async () => ({ id: HUMAN.id }) }) as never,
            { resolve: async () => ({ library: { getCatalog: async () => catalog.map((name) => ({ name })) } }) } as never,
        );
    }

    const propose = (dto = { name: 'pnpm-install', scope: 'global' as const }) => service.propose(project.id, 'pat', dto, HUMAN);
    const statusOf = async () => (await lessons().find({ order: { text: 'ASC' } })).map((l) => l.status);

    it('creates one triage job in the library repo and moves candidate and approved lessons to applying with the job and skill name', async () => {
        const res = await propose();
        expect(res.lessonIds).toHaveLength(2);
        const job = await jobs().findOneByOrFail({ id: res.jobId });
        expect(job).toMatchObject({ repoId: library.id, status: 'triage', createdById: HUMAN.id, projectId: project.id });
        expect(job.task).toContain('Run pnpm install first');
        for (const l of await lessons().find()) {
            expect(l).toMatchObject({ status: 'applying', appliedJobId: job.id, appliedSkillName: 'pnpm-install', targetKind: 'library_skill', targetRepoId: library.id });
        }
        expect(await jobs().count()).toBe(1);
    });

    it('refuses without a verified human and creates nothing', async () => {
        const denied = build({ users: { requireVerifiedHuman: async () => { throw new ForbiddenException('nope'); } } });
        await expect(denied.propose(project.id, 'pat', { name: 'pnpm-install', scope: 'global' }, null)).rejects.toBeInstanceOf(ForbiddenException);
        expect(await jobs().count()).toBe(0);
        expect(await statusOf()).toEqual(['approved', 'candidate']);
    });

    it('refuses a project without a repo-backed library', async () => {
        await ds.getRepository(Project).update({ id: project.id }, { skillsLibrary: 'none', skillsLibraryRepoId: null });
        await expect(propose()).rejects.toBeInstanceOf(ConflictException);
        expect(await jobs().count()).toBe(0);
    });

    it('refuses a name already in the library, a name already being proposed, and an unreadable library', async () => {
        await expect(propose({ name: 'existing', scope: 'global' })).rejects.toThrow(/already has a skill named 'existing'/);
        await propose();
        // the first proposal moved the lessons to applying; a second pattern wants the same name
        const c = await lesson('Something else', 'candidate');
        const d = await lesson('Something else again', 'candidate');
        pattern = await patternOf([c, d]);
        await expect(propose()).rejects.toThrow(/already in progress/);
        catalog = [];
        const broken = build();
        (broken as never as { libraryResolver: unknown }).libraryResolver = { resolve: async () => { throw new Error('down'); } };
        await expect(broken.propose(project.id, 'pat', { name: 'other', scope: 'global' }, HUMAN)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('answers 409 for a stale pattern id and for a pattern whose members changed, without side effects', async () => {
        await expect(service.propose(project.id, 'old', { name: 'pnpm-install', scope: 'global' }, HUMAN)).rejects.toBeInstanceOf(ConflictException);
        await lessons().update({ id: pattern.members[0].lessonId }, { status: 'rejected' });
        await expect(propose()).rejects.toBeInstanceOf(ConflictException);
        expect(await jobs().count()).toBe(0);
        expect(await statusOf()).toEqual(['approved', 'rejected']);
    });

    it('rolls the job back when a lesson cannot be moved', async () => {
        const rejected = await lesson('Rejected one', 'rejected');
        pattern = { ...pattern, members: [...pattern.members, { lessonId: rejected.id, text: rejected.text, status: 'candidate', sources: [] }] };
        await expect(propose()).rejects.toBeInstanceOf(ConflictException);
        expect(await jobs().count()).toBe(0);
        expect((await lessons().find({ where: { status: 'applying' } }))).toHaveLength(0);
    });

    it('rejects a pattern that holds an applying or applied lesson before creating anything', async () => {
        const applied = await lesson('Applied', 'applied');
        pattern = { ...pattern, members: [...pattern.members, { lessonId: applied.id, text: applied.text, status: 'applied', sources: [] }] };
        await expect(propose()).rejects.toBeInstanceOf(ConflictException);
        expect(await jobs().count()).toBe(0);
    });

    it('lets onJobEnded finish all lessons: applied on merge, approved again on failure', async () => {
        const { jobId } = await propose();
        const lessonService = new LessonService(new LessonMapper(), lessons(), ds.getRepository(LessonSource), jobs(), ds.getRepository(Repo), {} as never, {} as never, {} as never);
        await lessonService.onJobEnded(jobId, 'rejected', 'bad');
        expect(await statusOf()).toEqual(['approved', 'approved']);
        const again = await propose({ name: 'pnpm-install', scope: 'global' }).catch((e) => e);
        expect(again).toBeInstanceOf(ConflictException); // stale: the lessons changed status since the pattern was read
        pattern = await patternOf(await lessons().find({ order: { text: 'ASC' } }));
        const second = await propose();
        await lessonService.onJobEnded(second.jobId, 'merged');
        const done = await lessons().find();
        expect(done.every((l) => l.status === 'applied' && l.appliedAt !== null)).toBe(true);
    });
});
