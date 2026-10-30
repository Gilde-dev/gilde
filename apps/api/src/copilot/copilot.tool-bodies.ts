import { HttpException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';

import type { DispatcherService } from '../dispatch/dispatcher.service.js';
import type { FeatureResponseDto } from '../feature/feature.dto.js';
import type { FeatureService } from '../feature/feature.service.js';
import { FEATURE_STATUSES } from '../feature/feature-state.js';
import { JOB_STATUSES } from '../job/job-state.js';
import type { GitHubPort } from '../github/github.port.js';
import type { RepoWorkspaceService } from '../workspace/repo-workspace.service.js';
import { CreateJobSchema, JobContentSchema, type JobResponseDto } from '../job/job.dto.js';
import { taskContentProblem } from '../job/task-size.js';
import type { JobService } from '../job/job.service.js';
import { LESSON_STATUSES } from '../lesson/lesson-state.js';
import type { LessonService } from '../lesson/lesson.service.js';
import type { LessonPatternService } from '../lesson/lesson-pattern.service.js';
import { HistorySearchSchema } from '../memory/history/history.dto.js';
import type { HistorySearchService } from '../memory/history/history-search.service.js';
import type { MetricsService } from '../metrics/metrics.service.js';
import type { ProjectService } from '../project/project.service.js';
import type { ProjectMcpToolsService } from '../project-mcp/project-mcp-tools.service.js';
import type { RepoService } from '../repo/repo.service.js';
import { REVISION_STATUSES } from '../revision/revision.entity.js';
import type { RevisionService } from '../revision/revision.service.js';
import type { SkillService } from '../skill/skill.service.js';
import { CreateSpecSchema, SaveSpecVersionSchema, type SpecDetailResponseDto } from '../spec/spec.dto.js';
import type { SpecService } from '../spec/spec.service.js';

import { createCodeToolBodies } from './copilot.code-tools.js';
import type { CopilotUser } from './copilot.context.js';
import type { FeaturePlanService } from './feature-plan.service.js';

/**
 * Framework-neutral tool bodies shared by the co-pilot (Mastra tools) and the MCP server. A body takes the validated input
 * and the acting user, which each front-end gets from its own trusted source (the Mastra request context, req.user);
 * it never reads an actor from the input. Approval flags, descriptions and annotations belong to the front-ends.
 */

/** A job without its task text and criteria, for list results. */
export const compactJob = (j: JobResponseDto) => ({
    id: j.id,
    title: j.title,
    status: j.status,
    repoId: j.repoId,
    featureId: j.featureId,
    prNumber: j.prNumber,
    prUrl: j.prUrl,
    attempts: j.attempts,
    lastReason: j.lastReason,
    /** Why a queued job is not being fired: no executor, executor busy, executor limit reached or executor exhausted until <time>. */
    waitingReason: j.waitingReason,
    ownerId: j.ownerId,
    blockedBy: j.blockedBy,
    mergedBlocked: j.mergedBlocked,
    /** Read-only: the open PR conflicts with its base branch. */
    mergeConflict: j.mergeConflict,
    failedDependency: j.failedDependency,
    /** The merged or open PR lists manual steps (env, permission, CLI, infra) that are not all done; read the job for the list. */
    needsOperatorAction: j.needsOperatorAction,
});

/** A feature without its spec and criteria, for list results. */
export const compactFeature = (f: FeatureResponseDto) => ({ id: f.id, projectId: f.projectId, title: f.title, status: f.status, progress: f.progress });

/**
 * A spec for the model: the caller-specific approval flags are left out (the co-pilot never approves), and only the current
 * and the approved version carry their body, so a long history does not flood the context.
 */
export const compactSpec = (d: SpecDetailResponseDto) => {
    const { mayApprove: _a, mayApproveReasons: _b, versions, ...spec } = d;
    return {
        ...spec,
        versions: versions.map((v) => ({
            version: v.version,
            title: v.title,
            bodySha256: v.bodySha256,
            createdAt: v.createdAt,
            eligibility: v.eligibility,
            approval: v.approval,
            recording: v.recording && { jobId: v.recording.jobId, jobStatus: v.recording.jobStatus, state: v.recording.state, prUrl: v.recording.prUrl },
            criteria: v.criteria,
            ...(v.version === d.currentVersion || v.version === d.approvedVersion ? { body: v.body } : {}),
        })),
    };
};

/** The existing services the tools call. Tools never query repositories or the HTTP API. */
export interface CopilotServices {
    jobs: JobService;
    features: FeatureService;
    revisions: RevisionService;
    dispatcher: DispatcherService;
    metrics: MetricsService;
    lessons: LessonService;
    lessonPatterns: LessonPatternService;
    skills: SkillService;
    projects: ProjectService;
    repos: RepoService;
    github: GitHubPort;
    workspace: RepoWorkspaceService;
    history: HistorySearchService;
    specs: SpecService;
    plans: FeaturePlanService;
    /** The project's MCP tools (co-pilot, Verkenner, Verfijner). Absent in unit tests that do not need them. */
    mcpTools?: Pick<ProjectMcpToolsService, 'buildTools'>;
}

export const toolId = (what: string) => z.string().uuid().describe(`Id of the ${what}, taken from another tool result. Never invent one.`);
const id = toolId;

export const listJobsInput = z.object({
    projectId: id('project').optional(),
    repoId: id('repo').optional(),
    featureId: id('feature').optional(),
    status: z.enum(JOB_STATUSES).optional(),
    createdBy: z.literal('me').optional().describe('Only jobs created by the current user'),
    limit: z.number().int().min(1).max(200).default(25),
});
export const listProjectsInput = z.object({});
export const listReposInput = z.object({ projectId: id('project') });
export const getJobInput = z.object({ jobId: id('job') });
export const listFeaturesInput = z.object({ projectId: id('project'), status: z.enum(FEATURE_STATUSES).optional() });
export const getFeatureInput = z.object({ featureId: id('feature') });
export const listProposalsInput = z.object({ projectId: id('project').optional(), status: z.enum(REVISION_STATUSES).default('proposed') });
export const getDispatchStatusInput = z.object({});
export const getMetricsInput = z.object({
    days: z.number().int().min(1).max(365).default(30).describe('Window in days'),
    projectId: id('project').optional(),
    repoId: id('repo').optional(),
});
export const listLessonsInput = z.object({ status: z.enum(LESSON_STATUSES).optional(), projectId: id('project').optional() });
export const listLessonPatternsInput = z.object({
    projectId: id('project'),
    minSize: z.number().int().min(2).max(100).default(2).describe('Smallest number of lessons in a pattern'),
});
export const getRepoSkillsInput = z.object({ repoId: id('repo') });
export const getSkillImpactInput = z.object({
    projectId: id('project'),
    days: z.number().int().min(1).max(180).optional().describe('Window in days (default 30, max 180)'),
});
export const listSpecsInput = z.object({ projectId: id('project') });
export const getSpecInput = z.object({ specId: id('spec') });

export const planInput = z.object({
    projectId: id('project'),
    specId: id('spec').optional().describe('Plan from this approved spec: pass together with specApproval, taken from getSpec. Omit both for work without a spec.'),
    specApproval: z.object({
        version: z.number().int().describe('The approvedVersion of the spec'),
        approvalId: z.string().uuid().describe('The id of that version\'s approval record (versions[].approval.id)'),
    }).optional().describe('The exact approved version this plan is made from'),
    title: z.string().describe('Feature title, 3-200 characters'),
    spec: z.string().describe('What the feature is and why, up to 20000 characters'),
    acceptanceCriteria: z.array(z.string()).describe('Testable criteria of the whole feature'),
    jobs: z.array(z.object({
        key: z.string().describe('Short key, local to this draft (e.g. "api")'),
        repoId: id('repo'),
        title: z.string().describe('3-200 characters'),
        task: z.string().describe('The full task for the agent, at least 10 characters'),
        acceptanceCriteria: z.array(z.string()).describe('Concrete, testable criteria'),
        dependsOn: z.array(z.string()).describe('Keys of jobs in this draft that must be merged first; [] when none'),
    })),
});

export const draftSpecInput = z.object({
    specId: id('spec').optional().describe('Set to save a new version of this spec; omit to create a new spec'),
    projectId: id('project').optional().describe('Only when creating'),
    repoId: id('repo').optional().describe('Only when creating: the repo the spec file will live in'),
    slug: z.string().optional().describe('Only when creating: kebab-case, fixed for the life of the spec'),
    title: z.string().describe('3-200 characters'),
    body: z.string().describe('The whole spec as markdown, saved byte for byte'),
    expectedVersion: z.number().int().min(0).describe('0 when creating, otherwise the currentVersion you saw'),
});

/** Fields shared by validateJob and createJob. */
export const jobInput = z.object({
    repoId: id('repo'),
    title: z.string().describe('3-200 characters'),
    task: z.string().describe('The full task for the agent, at least 10 characters'),
    acceptanceCriteria: z.array(z.string()).describe('At most 20 concrete, testable criteria of at least 3 characters'),
    dependsOn: z.array(z.string()).default([]).describe('Ids of existing jobs in the same project that must be merged first; [] when none'),
    featureId: id('feature').optional().describe('An existing open feature of the same project to put the job in'),
});
const JobDraftSchema = JobContentSchema.extend({ dependsOn: CreateJobSchema.shape.dependsOn });

/** Checks a single job against the repo, feature, dependencies and the limits of CreateJobSchema. Writes nothing. */
export async function validateJobDraft(s: Pick<CopilotServices, 'repos' | 'features' | 'jobs'>, input: z.infer<typeof jobInput>) {
    const problems: string[] = [];
    const parsed = JobDraftSchema.safeParse({ title: input.title, task: input.task, acceptanceCriteria: input.acceptanceCriteria, dependsOn: [] });
    if (!parsed.success) problems.push(...parsed.error.issues.map((i) => `${i.path.join('.') || 'job'}: ${i.message}`));
    else {
        const tooLarge = taskContentProblem(parsed.data.task, parsed.data.acceptanceCriteria ?? []);
        if (tooLarge) problems.push(tooLarge);
    }
    const dependsOn = input.dependsOn ?? [];
    if (dependsOn.length > 20) problems.push('dependsOn: at most 20 dependencies');
    if (new Set(dependsOn).size !== dependsOn.length) problems.push('dependsOn: duplicate dependencies');

    let repo: Awaited<ReturnType<RepoService['getById']>> | null = null;
    try {
        repo = await s.repos.getById(input.repoId);
    } catch {
        problems.push(`Unknown repo ${input.repoId}`);
    }

    let featureTitle: string | null = null;
    if (input.featureId) {
        try {
            const feature = await s.features.getById(input.featureId);
            featureTitle = feature.title;
            if (repo && feature.projectId !== repo.projectId) problems.push(`Feature "${feature.title}" is in another project than the repo`);
            if (feature.status === 'done' || feature.status === 'cancelled') problems.push(`Feature "${feature.title}" is ${feature.status}; pick an open feature`);
        } catch {
            problems.push(`Unknown feature ${input.featureId}`);
        }
    }

    const dependencies: { id: string; title: string }[] = [];
    for (const depId of new Set(dependsOn)) {
        try {
            const dep = await s.jobs.getById(depId);
            if (repo && dep.projectId !== repo.projectId) problems.push(`Dependency "${dep.title}" is in another project than the repo`);
            else dependencies.push({ id: dep.id, title: dep.title });
        } catch {
            problems.push(`Unknown dependency job ${depId}`);
        }
    }

    if (problems.length || !repo || !parsed.success) return { valid: false as const, problems };
    return {
        valid: true as const,
        job: {
            repoId: repo.id,
            repoFullName: repo.fullName,
            projectId: repo.projectId,
            featureId: input.featureId ?? null,
            featureTitle,
            title: parsed.data.title,
            task: parsed.data.task,
            acceptanceCriteria: parsed.data.acceptanceCriteria ?? [],
            dependsOn,
            dependencies,
        },
    };
}

export type JobCreation = { created: true; jobId: string; link: string; projectId: string } | { created: false; problems: string[] };

/**
 * Revalidates the draft and creates ONE job with status triage as `actor` (never the entity default, never a caller-chosen
 * status). `manager` runs the write in the caller's transaction.
 */
export async function createTriageJob(
    s: Pick<CopilotServices, 'repos' | 'features' | 'jobs'>,
    input: z.infer<typeof jobInput>,
    actor: { id: string } | null,
    manager?: EntityManager,
): Promise<JobCreation> {
    const checked = await validateJobDraft(s, input);
    if (!checked.valid) return { created: false, problems: checked.problems };
    const { job } = checked;
    const dto = { title: job.title, task: job.task, acceptanceCriteria: job.acceptanceCriteria, dependsOn: job.dependsOn, featureId: job.featureId ?? undefined, status: 'triage' as const };
    const created = manager ? await s.jobs.create(job.repoId, dto, actor, manager) : await s.jobs.create(job.repoId, dto, actor);
    return { created: true, jobId: created.id, link: `/?project=${job.projectId}&job=${created.id}`, projectId: job.projectId };
}

/**
 * Saves a spec as a DRAFT (a new spec, or a new version with the caller's expectedVersion); never approves. Throws the
 * ZodError or HttpException (for example a stale expectedVersion: 409) for the front-end to present.
 */
export async function saveSpecDraft(s: Pick<CopilotServices, 'specs'>, input: z.infer<typeof draftSpecInput>, actor: CopilotUser) {
    let detail: SpecDetailResponseDto;
    if (input.specId) {
        const dto = SaveSpecVersionSchema.parse({ title: input.title, body: input.body, expectedVersion: input.expectedVersion });
        detail = await s.specs.saveVersion(input.specId, dto, actor);
    } else {
        if (!input.projectId || !input.repoId || !input.slug) return { saved: false as const, problems: ['Creating a spec needs projectId, repoId and slug'] };
        const dto = CreateSpecSchema.parse({ repoId: input.repoId, slug: input.slug, title: input.title, body: input.body, expectedVersion: input.expectedVersion });
        detail = await s.specs.create(input.projectId, dto, actor);
    }
    return { saved: true as const, specId: detail.id, version: detail.currentVersion, status: detail.status, approved: false as const };
}

/** Bodies of the read tools, the validate-only tools and the code tools: they change nothing. */
export function createReadToolBodies(s: CopilotServices) {
    const listProjects = async () => s.projects.list();
    const listRepos = async ({ projectId }: z.infer<typeof listReposInput>) => s.repos.listForProject(projectId);
    const listJobs = async ({ limit, ...filter }: z.infer<typeof listJobsInput>, actor: CopilotUser | null) =>
        (await s.jobs.list({ ...filter, limit }, actor)).map(compactJob);
    const getJob = async ({ jobId }: z.infer<typeof getJobInput>) => {
        const [job, revisions] = await Promise.all([s.jobs.getDetail(jobId), s.revisions.listForJob(jobId)]);
        return { ...job, revisions };
    };
    const listFeatures = async ({ projectId, status }: z.infer<typeof listFeaturesInput>) => (await s.features.list(projectId, { status })).map(compactFeature);
    const getFeature = async ({ featureId }: z.infer<typeof getFeatureInput>) => s.features.getDetail(featureId);
    const listProposals = async (q: z.infer<typeof listProposalsInput>) => s.revisions.list(q);
    const getDispatchStatus = async () => s.dispatcher.status();
    const getMetrics = async (q: z.infer<typeof getMetricsInput>) => s.metrics.get(q);
    const listLessons = async (q: z.infer<typeof listLessonsInput>) => s.lessons.list(q);
    /** Patterns without per-source excerpts: lesson ids, texts and statuses are enough to cite, getJob/listLessons give the rest. */
    const listLessonPatterns = async ({ projectId, minSize }: z.infer<typeof listLessonPatternsInput>) => {
        const { method, threshold, patterns } = await s.lessonPatterns.list(projectId, { minSize });
        return {
            method,
            threshold,
            patterns: patterns.map(({ members, ...p }) => ({ ...p, members: members.map(({ sources: _s, ...m }) => m) })),
        };
    };
    const getRepoSkills = async ({ repoId }: z.infer<typeof getRepoSkillsInput>) => s.skills.forRepo(repoId);
    const getSkillImpact = async ({ projectId, days }: z.infer<typeof getSkillImpactInput>) => s.skills.impact(projectId, days);
    const listSpecs = async ({ projectId }: z.infer<typeof listSpecsInput>) => s.specs.list(projectId);
    const getSpec = async ({ specId }: z.infer<typeof getSpecInput>) => compactSpec(await s.specs.getDetail(specId, null));
    const planFeature = async (input: z.infer<typeof planInput>) => s.plans.validate(input);
    const validateJob = async (input: z.infer<typeof jobInput>) => validateJobDraft(s, input);
    const searchHistory = async (input: z.infer<typeof HistorySearchSchema>) => {
        try {
            return await s.history.search(input);
        } catch (e) {
            if (e instanceof HttpException) return { status: 'invalid' as const, problem: e.message, results: [] };
            throw e;
        }
    };
    return {
        ...createCodeToolBodies(s),
        listProjects, listRepos, listJobs, getJob, listFeatures, getFeature, listProposals, getDispatchStatus, getMetrics,
        listLessons, listLessonPatterns, getRepoSkills, getSkillImpact, listSpecs, getSpec, planFeature, validateJob, searchHistory,
    };
}
