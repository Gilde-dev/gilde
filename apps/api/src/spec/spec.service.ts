import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, IsNull, Repository } from 'typeorm';

import type { AuthUser } from '../auth/auth.dto.js';
import { isUniqueViolation } from '../common/db-errors.js';
import { Job } from '../job/job.entity.js';
import { JobService } from '../job/job.service.js';
import { ProjectService } from '../project/project.service.js';
import { RepoService } from '../repo/repo.service.js';
import { UserService } from '../user/user.service.js';
import { KeyedMutex } from './keyed-mutex.js';
import type {
    ApproveSpecDto,
    CreateSpecDto,
    SaveSpecVersionDto,
    SpecDetailResponseDto,
    SpecRecordingDto,
    SpecResponseDto,
    SpecVersionResponseDto,
} from './spec.dto.js';
import { SpecApproval } from './spec-approval.entity.js';
import { Spec } from './spec.entity.js';
import { SpecMapper } from './spec.mapper.js';
import { SpecRecording } from './spec-recording.entity.js';
import { recordingJobContent, recordingState, sha256 } from './spec-recording.js';
import { SpecVersion } from './spec-version.entity.js';
import { approvalBlockers, checkCriteriaHistory, parseSpec, type ParseIssue } from './spec-parser.js';

@Injectable()
export class SpecService {

    /** One writer at a time per spec (per process); on SQLite one for all, as its connection is shared. Postgres also locks the row. */
    private readonly writers = new KeyedMutex();

    constructor(
        private readonly mapper: SpecMapper,
        private readonly projectService: ProjectService,
        private readonly repoService: RepoService,
        private readonly userService: UserService,
        private readonly jobService: JobService,
        @InjectRepository(Spec) private readonly specRepository: Repository<Spec>,
        @InjectRepository(SpecVersion) private readonly versionRepository: Repository<SpecVersion>,
        @InjectRepository(SpecApproval) private readonly approvalRepository: Repository<SpecApproval>,
        @InjectRepository(SpecRecording) private readonly recordingRepository: Repository<SpecRecording>,
        @InjectRepository(Job) private readonly jobRepository: Repository<Job>,
    ) { }

    async create(projectId: string, dto: CreateSpecDto, actor: AuthUser | null): Promise<SpecDetailResponseDto> {
        await this.projectService.getById(projectId); // 404 if unknown
        const repo = await this.repoService.getById(dto.repoId); // 404 if unknown
        if (repo.projectId !== projectId) throw new BadRequestException(`Repo ${dto.repoId} is not in project ${projectId}`);
        if (dto.expectedVersion !== 0) throw new ConflictException('A new spec has no version yet; send expectedVersion 0');
        const parsed = parseSpec(dto.body);
        this.assertSaveable(parsed.issues);
        let created: Spec;
        try {
            created = await this.specRepository.manager.transaction(async (m) => {
                const spec = await m.save(m.create(Spec, {
                    projectId,
                    repoId: dto.repoId,
                    slug: dto.slug,
                    title: dto.title,
                    status: 'draft',
                    currentVersion: 1,
                    approvedVersion: null,
                    createdById: actor?.id ?? null,
                    updatedById: actor?.id ?? null,
                    approvedById: null,
                    approvedAt: null,
                }));
                await m.insert(SpecVersion, this.versionRow(spec.id, 1, dto.title, dto.body, parsed.criteria.map((c) => c.number), actor));
                return spec;
            });
        } catch (e) {
            if (isUniqueViolation(e)) throw new ConflictException(`A spec with slug "${dto.slug}" already exists in this repo`);
            throw e;
        }
        return this.getDetail(created.id, actor);
    }

    async list(projectId: string): Promise<SpecResponseDto[]> {
        await this.projectService.getById(projectId);
        const specs = await this.specRepository.find({ where: { projectId }, order: { updatedAt: 'DESC', id: 'ASC' } });
        return specs.map((s) => this.mapper.toDTO(s));
    }

    async getDetail(id: string, caller: AuthUser | null): Promise<SpecDetailResponseDto> {
        const spec = await this.getOrFail(id);
        return this.detail(spec, caller);
    }

    /** Saves a new immutable version; the spec goes back to draft. Earlier approvals and recordings stay as evidence. */
    async saveVersion(id: string, dto: SaveSpecVersionDto, actor: AuthUser | null): Promise<SpecDetailResponseDto> {
        const parsed = parseSpec(dto.body);
        this.assertSaveable(parsed.issues);
        await this.locked(id, async (m) => {
            const spec = await this.currentSpec(m, id, dto.expectedVersion);
            const earlier = await m.find(SpecVersion, { where: { specId: id }, select: { version: true, criteriaNumbers: true } });
            const latest = earlier.find((v) => v.version === spec.currentVersion);
            const history = checkCriteriaHistory(parsed.criteria, {
                latest: latest?.criteriaNumbers ?? [],
                ever: earlier.flatMap((v) => v.criteriaNumbers),
            });
            this.assertSaveable(history);
            const version = spec.currentVersion + 1;
            await m.insert(SpecVersion, this.versionRow(id, version, dto.title, dto.body, parsed.criteria.map((c) => c.number), actor));
            const result = await m.update(Spec, { id, currentVersion: spec.currentVersion }, {
                currentVersion: version,
                title: dto.title,
                status: 'draft',
                updatedById: actor?.id ?? null,
            });
            if (!result.affected) throw new ConflictException('The spec changed in the meantime, reload and try again');
        });
        return this.getDetail(id, actor);
    }

    /**
     * Approves the current version as a verified human (JWT only, persisted, not a bot) and, in the same transaction,
     * records the audit evidence and makes sure exactly one triage recording job exists for it. Repeating the call for an
     * approved version changes nothing.
     */
    async approve(id: string, dto: ApproveSpecDto, user: AuthUser | undefined): Promise<SpecDetailResponseDto> {
        const approver = await this.userService.requireVerifiedHuman(user); // 403 before anything is read
        try {
            await this.locked(id, (m) => this.approveIn(m, id, dto.expectedVersion, { ...approver, name: user?.name ?? approver.email }));
        } catch (e) {
            // A concurrent approval of the same version (another process) won the unique index: the outcome is the same.
            if (!isUniqueViolation(e) || !(await this.approvalRepository.findOneBy({ specId: id, version: dto.expectedVersion }))) {
                if (isUniqueViolation(e)) throw new ConflictException('The spec changed in the meantime, try again');
                throw e;
            }
        }
        return this.getDetail(id, user ?? null);
    }

    /** Marks a version's recording as pinned by a feature, so it is never replaced or cancelled. Idempotent per feature. */
    async pinRecording(specId: string, version: number, featureId: string, manager?: EntityManager): Promise<void> {
        const recordings = manager?.getRepository(SpecRecording) ?? this.recordingRepository;
        const recording = await recordings.findOneBy({ specId, version });
        if (!recording) throw new NotFoundException(`Spec ${specId} version ${version} has no recording`);
        if (recording.pinnedByFeatureId === featureId) return;
        const result = await recordings.update({ id: recording.id, pinnedByFeatureId: IsNull() }, { pinnedByFeatureId: featureId });
        if (!result.affected) throw new ConflictException('This recording is already pinned by another feature');
    }

    // --- approval -----------------------------------------------------------------------------------------------

    private async approveIn(m: EntityManager, id: string, expectedVersion: number, approver: { id: string; email: string; name: string }): Promise<void> {
        const { name } = approver;
        const spec = await this.currentSpec(m, id, expectedVersion);
        const existing = await m.findOneBy(SpecApproval, { specId: id, version: spec.currentVersion });
        if (existing) return; // already approved: nothing to do, no second recording
        const version = await m.findOneByOrFail(SpecVersion, { specId: id, version: spec.currentVersion });
        const reasons = approvalBlockers(parseSpec(version.body));
        if (reasons.length) throw new UnprocessableEntityException({ message: 'This version cannot be approved yet', reasons });
        
        const approval = await m.save(m.create(SpecApproval, {
            specId: id,
            specVersionId: version.id,
            version: version.version,
            approvedById: approver.id,
            approvedByName: name,
            approvedByEmail: approver.email,
            credential: 'jwt',
        }));
        const marked = await m.update(Spec, { id, currentVersion: version.version }, {
            status: 'approved',
            approvedVersion: version.version,
            approvedById: approver.id,
            approvedAt: approval.approvedAt,
        });
        if (!marked.affected) throw new ConflictException('The spec changed in the meantime, reload and try again');

        const repo = await this.repoService.getById(spec.repoId);
        const content = recordingJobContent({
            specId: id,
            specVersionId: version.id,
            slug: spec.slug,
            title: version.title,
            version: version.version,
            body: version.body,
            bodySha256: version.bodySha256,
            approver: { id: approver.id, name, email: approver.email },
            approvedAt: approval.approvedAt,
            repoFullName: repo.fullName,
            baseBranch: repo.defaultBranch,
        });
        await this.recordVersion(m, spec, version, approval, content, approver);
    }

    /**
     * Makes the recording job for a newly approved version, serialised behind older ones:
     * - the newest active recording is an unstarted triage job (and not pinned): reuse it in place for this version;
     * - it is an unstarted queued job: cancel it through the state machine and make a fresh triage job with its prerequisite;
     * - otherwise (in flight, failed, merged, pinned) never touch it: a new triage job waits for it to merge.
     * A conditional write that loses to the dispatcher (or anyone) re-reads the job and decides again.
     */
    private async recordVersion(
        m: EntityManager, spec: Spec, version: SpecVersion, approval: SpecApproval,
        content: { title: string; task: string; acceptanceCriteria: string[] }, approver: { id: string },
    ): Promise<void> {
        const [latest] = await m.find(SpecRecording, { where: { specId: spec.id, supersededAt: IsNull() }, order: { version: 'DESC' }, take: 1 });
        let jobId: string | null = null;
        let dependsOnJobId: string | null = null;
        let replaces: SpecRecording | null = null;

        if (latest) {
            let settled = false;
            for (let attempt = 0; attempt < 3 && !settled; attempt++) {
                const job = await m.findOneBy(Job, { id: latest.jobId });
                const replaceable = !!job && !latest.pinnedByFeatureId && job.attempts === 0 && job.prNumber === null;
                if (replaceable && job.status === 'triage') {
                    settled = await this.jobService.rewriteUnstartedTriageIn(m, job.id, content, approver);
                    if (settled) { jobId = job.id; dependsOnJobId = latest.dependsOnJobId; replaces = latest; }
                } else if (replaceable && job.status === 'queued') {
                    settled = await this.jobService.cancelUnstartedQueuedIn(m, job.id);
                    if (settled) { dependsOnJobId = latest.dependsOnJobId; replaces = latest; }
                } else if (job) {
                    // Never touch work that started, failed or is pinned: a new triage job waits for it, unless it merged cleanly.
                    settled = true;
                    dependsOnJobId = job.status === 'merged' && !job.mergedBlocked ? null : job.id;
                }
                // else: lost a race against the dispatcher; read the job again and decide on what it is now.
            }
            if (!settled) throw new ConflictException('A recording job changed in the meantime, try again');
        }
        if (!jobId) {
            const created = await this.jobService.create(spec.repoId, {
                ...content,
                status: 'triage',
                dependsOn: dependsOnJobId ? [dependsOnJobId] : [],
            }, approver, m);
            jobId = created.id;
        }
        const recording = await m.save(m.create(SpecRecording, {
            specId: spec.id,
            specVersionId: version.id,
            version: version.version,
            approvalId: approval.id,
            jobId,
            dependsOnJobId,
            supersededByRecordingId: null,
            supersededAt: null,
            pinnedByFeatureId: null,
        }));
        if (replaces) {
            const marked = await m.update(SpecRecording, { id: replaces.id, supersededAt: IsNull() }, { supersededByRecordingId: recording.id, supersededAt: new Date() });
            if (!marked.affected) throw new ConflictException('A recording changed in the meantime, try again');
        }
    }

    // --- helpers ------------------------------------------------------------------------------------------------

    private assertSaveable(issues: ParseIssue[]): void {
        if (!issues.length) return;
        throw new BadRequestException({
            message: 'The spec does not follow the template',
            issues: issues.map((i) => ({ path: i.line === null ? 'body' : `body:${i.line}`, message: i.message })),
        });
    }

    private versionRow(specId: string, version: number, title: string, body: string, criteriaNumbers: number[], actor: AuthUser | null) {
        return { specId, version, title, body, bodySha256: sha256(body), criteriaNumbers, createdById: actor?.id ?? null };
    }

    /** The spec if it is at the version the caller saw; 404 when unknown, 409 when stale. */
    private async currentSpec(m: EntityManager, id: string, expectedVersion: number): Promise<Spec> {
        const spec = await m.findOneBy(Spec, { id });
        if (!spec) throw new NotFoundException(`Spec ${id} not found`);
        if (spec.currentVersion !== expectedVersion) {
            throw new ConflictException({
                message: `The spec is at version ${spec.currentVersion}, not ${expectedVersion}`,
                currentVersion: spec.currentVersion,
            });
        }
        return spec;
    }

    private async getOrFail(id: string): Promise<Spec> {
        const spec = await this.specRepository.findOneBy({ id });
        if (!spec) throw new NotFoundException(`Spec ${id} not found`);
        return spec;
    }

    /** Runs `fn` in a transaction while holding the spec's write slot (and, on Postgres, its row lock). */
    private locked<T>(id: string, fn: (m: EntityManager) => Promise<T>): Promise<T> {
        const postgres = this.specRepository.manager.connection.options.type === 'postgres';
        return this.writers.run(postgres ? id : 'sqlite', () => this.specRepository.manager.transaction(async (m) => {
            if (postgres) await m.createQueryBuilder(Spec, 's').setLock('pessimistic_write').where('s.id = :id', { id }).getOne();
            return fn(m);
        }));
    }

    private async detail(spec: Spec, caller: AuthUser | null): Promise<SpecDetailResponseDto> {
        const [versions, approvals, recordings] = await Promise.all([
            this.versionRepository.find({ where: { specId: spec.id }, order: { version: 'DESC' } }),
            this.approvalRepository.find({ where: { specId: spec.id } }),
            this.recordingRepository.find({ where: { specId: spec.id } }),
        ]);
        const jobs = recordings.length
            ? await this.jobRepository.find({ where: { id: In([...new Set(recordings.map((r) => r.jobId))]) } })
            : [];
        const jobById = new Map(jobs.map((j) => [j.id, j]));
        const approvalByVersion = new Map(approvals.map((a) => [a.version, a]));
        const recordingByVersion = new Map(recordings.map((r) => [r.version, r]));

        const dtoVersions: SpecVersionResponseDto[] = versions.map((v) => {
            const parsed = parseSpec(v.body);
            const reasons = approvalBlockers(parsed);
            const approval = approvalByVersion.get(v.version);
            const recording = recordingByVersion.get(v.version);
            return {
                id: v.id,
                version: v.version,
                title: v.title,
                body: v.body,
                bodySha256: v.bodySha256,
                criteria: parsed.criteria,
                createdById: v.createdById,
                createdAt: v.createdAt.toISOString(),
                eligibility: { eligible: reasons.length === 0, reasons },
                approval: approval ? this.mapper.approvalToDTO(approval) : null,
                recording: recording ? this.recordingDto(recording, jobById.get(recording.jobId)) : null,
            };
        });
        const current = dtoVersions.find((v) => v.version === spec.currentVersion);
        const may = await this.mayApprove(caller);
        return {
            ...this.mapper.toDTO(spec),
            mayApprove: may.allowed,
            mayApproveReasons: may.reasons,
            eligibility: current?.eligibility ?? { eligible: false, reasons: ['No current version'] },
            versions: dtoVersions,
        };
    }

    private recordingDto(row: SpecRecording, job: Job | undefined): SpecRecordingDto {
        return {
            id: row.id,
            jobId: row.jobId,
            jobStatus: job?.status ?? 'cancelled',
            jobTitle: job?.title ?? '',
            prUrl: job?.prUrl ?? null,
            state: recordingState(row, job),
            mergedWithoutWork: !!job && job.status === 'merged' && job.mergedBlocked,
            dependsOnJobId: row.dependsOnJobId,
            supersededByRecordingId: row.supersededByRecordingId,
            supersededAt: row.supersededAt?.toISOString() ?? null,
            pinnedByFeatureId: row.pinnedByFeatureId,
            createdAt: row.createdAt.toISOString(),
        };
    }

    /** Whether this caller may approve at all (same check the approve route enforces), with the reason when not. */
    private async mayApprove(caller: AuthUser | null): Promise<{ allowed: boolean; reasons: string[] }> {
        try {
            await this.userService.requireVerifiedHuman(caller ?? undefined);
            return { allowed: true, reasons: [] };
        } catch (e) {
            if (e instanceof ForbiddenException) return { allowed: false, reasons: [e.message] };
            throw e;
        }
    }
}
