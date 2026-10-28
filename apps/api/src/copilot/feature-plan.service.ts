import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { Feature } from '../feature/feature.entity.js';
import type { FeatureSpecPin } from '../feature/feature-spec-pin.js';
import { JobService } from '../job/job.service.js';
import { taskContentProblem } from '../job/task-size.js';
import { Project } from '../project/project.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { SpecService, type ApprovedSpecTarget } from '../spec/spec.service.js';

import { specTaskContext, specPath, withSpecContext } from './feature-plan-context.js';
import { dependencyOrder, FeaturePlanSchema, graphProblems, sizeProblems, type FeaturePlan } from './copilot.plan.js';

/** The pinned version a valid plan is made from, as shown to the user. */
export interface PlanSpecSummary {
    specId: string;
    slug: string;
    title: string;
    version: number;
    approvalId: string;
    bodySha256: string;
    repoFullName: string;
    path: string;
    recordingJobId: string;
    recordingJobTitle: string;
    recordingState: ApprovedSpecTarget['state'];
}

export type PlanValidation =
    | { valid: true; draft: FeaturePlan; spec: PlanSpecSummary | null }
    | { valid: false; problems: string[] };

export type PlanCreation =
    | { created: true; featureId: string; link: string; jobs: { key: string; jobId: string; status: 'triage' }[]; spec: PlanSpecSummary | null }
    | { created: false; problems: string[] };

export interface PlanCreateOptions {
    reserve?: (m: EntityManager, counts: { jobs: number }) => Promise<void>;
}

/** Thrown inside the transaction when the plan no longer validates, so everything rolls back. */
class PlanRejected extends Error {
    constructor(readonly problems: string[]) {
        super(problems.join('; '));
    }
}

/**
 * Validates and creates feature plans for the co-pilot. A feature, its spec pin, all its jobs and their dependencies are
 * written in one transaction, using one manager for every read and write, after the plan was validated again inside it.
 * A plan linked to a spec holds the spec's write slot for that, so it cannot interleave with an approval or a new draft.
 */
@Injectable()
export class FeaturePlanService {

    constructor(
        private readonly dataSource: DataSource,
        private readonly specs: SpecService,
        private readonly jobs: JobService,
    ) { }

    /** Checks a draft against the project, its repos and (when linked) the approved spec version. Writes nothing. */
    async validate(input: unknown): Promise<PlanValidation> {
        const checked = await this.check(input);
        return checked.valid ? { valid: true, draft: checked.draft, spec: checked.target ? this.summary(checked.target) : null } : checked;
    }

    /**
     * Creates the feature in draft and its jobs in triage, as `actor`; nothing is queued or started. All or nothing.
     * `reserve` runs inside the same transaction once the plan validated, with the number of jobs about to be written
     * (the MCP daily allowance); whatever it throws rolls everything back and propagates.
     */
    async create(input: unknown, actor: { id: string } | null, options: PlanCreateOptions = {}): Promise<PlanCreation> {
        const parsed = FeaturePlanSchema.safeParse(input);
        if (!parsed.success) return { created: false, problems: this.schemaProblems(parsed.error) };
        const { specId } = parsed.data;
        const work = (m: EntityManager) => this.createIn(m, parsed.data, actor, options);
        try {
            return specId
                ? await this.specs.withSpecLock(specId, work)
                : await this.dataSource.transaction(work);
        } catch (e) {
            if (e instanceof PlanRejected) return { created: false, problems: e.problems };
            throw e;
        }
    }

    private async createIn(m: EntityManager, input: FeaturePlan, actor: { id: string } | null, options: PlanCreateOptions): Promise<PlanCreation> {
        const checked = await this.check(input, m);
        if (!checked.valid) throw new PlanRejected(checked.problems);
        const { draft, target } = checked;
        await options.reserve?.(m, { jobs: draft.jobs.length });

        const feature = await m.save(m.create(Feature, {
            projectId: draft.projectId,
            title: draft.title,
            spec: draft.spec,
            acceptanceCriteria: draft.acceptanceCriteria,
            specId: target?.spec.id ?? null,
            specVersion: target?.version.version ?? null,
            specPin: target ? this.pinOf(target) : null,
            startedAt: null,
            doneAt: null,
        }));
        if (target) await this.specs.pinRecording(target.spec.id, target.version.version, feature.id, m);

        const repos = new Map((await m.find(Repo, { where: { projectId: draft.projectId } })).map((r) => [r.id, r]));
        const idByKey = new Map<string, string>();
        for (const j of dependencyOrder(draft.jobs)) {
            const repo = repos.get(j.repoId)!;
            const task = target ? withSpecContext(j.task, repo.defaultBranch, specTaskContext(target, j.repoId)) : j.task;
            const dependsOn = j.dependsOn.map((k) => idByKey.get(k)!);
            if (target) dependsOn.push(target.job.id);
            const job = await this.jobs.create(
                j.repoId,
                { title: j.title, task, acceptanceCriteria: j.acceptanceCriteria, dependsOn, status: 'triage', featureId: feature.id },
                actor,
                m,
            );
            idByKey.set(j.key, job.id);
        }
        return {
            created: true,
            featureId: feature.id,
            link: `/features/${feature.id}`,
            jobs: draft.jobs.map((j) => ({ key: j.key, jobId: idByKey.get(j.key)!, status: 'triage' as const })),
            spec: target ? this.summary(target) : null,
        };
    }

    /** Validation with `manager` reading inside a caller's transaction; without it, reads on the default connection. */
    private async check(input: unknown, manager?: EntityManager): Promise<{ valid: true; draft: FeaturePlan; target: ApprovedSpecTarget | null } | { valid: false; problems: string[] }> {
        const parsed = FeaturePlanSchema.safeParse(input);
        if (!parsed.success) return { valid: false, problems: this.schemaProblems(parsed.error) };
        const draft = parsed.data;
        const problems = [...graphProblems(draft.jobs), ...sizeProblems(draft.jobs)];
        const m = manager ?? this.dataSource.manager;

        const project = await m.findOneBy(Project, { id: draft.projectId });
        if (!project) return { valid: false, problems: [...problems, `Unknown project ${draft.projectId}`] };
        const repos = new Map((await m.find(Repo, { where: { projectId: draft.projectId } })).map((r) => [r.id, r]));
        for (const j of draft.jobs) {
            if (!repos.has(j.repoId)) problems.push(`Job "${j.key}": repo ${j.repoId} is not in the project`);
        }

        let target: ApprovedSpecTarget | null = null;
        if (draft.specId && draft.specApproval) {
            const inspected = await this.specs.inspectApprovedVersion(draft.specId, draft.specApproval, draft.projectId, m);
            if (!inspected.ok) problems.push(...inspected.problems);
            else {
                target = inspected.target;
                // The jobs get the spec context added, so the limit applies to what is stored.
                for (const j of draft.jobs) {
                    const repo = repos.get(j.repoId);
                    if (!repo) continue;
                    const task = withSpecContext(j.task, repo.defaultBranch, specTaskContext(target, j.repoId));
                    const tooLarge = taskContentProblem(task, j.acceptanceCriteria, `Job "${j.key}": the task with the spec context and acceptance criteria`);
                    if (tooLarge) problems.push(tooLarge);
                }
            }
        }
        return problems.length ? { valid: false, problems: [...new Set(problems)] } : { valid: true, draft, target };
    }

    private pinOf(t: ApprovedSpecTarget): FeatureSpecPin {
        return {
            specId: t.spec.id,
            specVersionId: t.version.id,
            version: t.version.version,
            slug: t.spec.slug,
            title: t.version.title,
            repoId: t.repo.id,
            repoFullName: t.repo.fullName,
            path: specPath(t.spec.slug),
            body: t.version.body,
            bodySha256: t.version.bodySha256,
            approvalId: t.approval.id,
            approvedAt: t.approval.approvedAt.toISOString(),
            approvedByName: t.approval.approvedByName,
            recordingId: t.recording.id,
            recordingJobId: t.job.id,
            recordingJobTitle: t.job.title,
        };
    }

    private summary(t: ApprovedSpecTarget): PlanSpecSummary {
        return {
            specId: t.spec.id,
            slug: t.spec.slug,
            title: t.version.title,
            version: t.version.version,
            approvalId: t.approval.id,
            bodySha256: t.version.bodySha256,
            repoFullName: t.repo.fullName,
            path: specPath(t.spec.slug),
            recordingJobId: t.job.id,
            recordingJobTitle: t.job.title,
            recordingState: t.state,
        };
    }

    private schemaProblems(error: { issues: { path: PropertyKey[]; message: string }[] }): string[] {
        return error.issues.map((i) => `${i.path.join('.') || 'draft'}: ${i.message}`);
    }
}
