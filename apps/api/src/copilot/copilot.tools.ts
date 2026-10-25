import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { DispatcherService } from '../dispatch/dispatcher.service.js';
import type { FeatureService } from '../feature/feature.service.js';
import { FEATURE_STATUSES } from '../feature/feature-state.js';
import { JOB_STATUSES } from '../job/job-state.js';
import type { JobService } from '../job/job.service.js';
import { LESSON_STATUSES } from '../lesson/lesson-state.js';
import type { LessonService } from '../lesson/lesson.service.js';
import type { MetricsService } from '../metrics/metrics.service.js';
import type { ProjectService } from '../project/project.service.js';
import type { RepoService } from '../repo/repo.service.js';
import { REVISION_STATUSES } from '../revision/revision.entity.js';
import type { RevisionService } from '../revision/revision.service.js';
import type { SkillService } from '../skill/skill.service.js';

import { copilotUser } from './copilot.context.js';

/** The existing services the co-pilot tools call. Tools never query repositories or the HTTP API. */
export interface CopilotServices {
    jobs: JobService;
    features: FeatureService;
    revisions: RevisionService;
    dispatcher: DispatcherService;
    metrics: MetricsService;
    lessons: LessonService;
    skills: SkillService;
    projects: ProjectService;
    repos: RepoService;
}

const id = (what: string) => z.string().uuid().describe(`Id of the ${what}, taken from another tool result. Never invent one.`);

/** Read-only tools: none of them changes anything. */
export function createCopilotTools(s: CopilotServices) {
    const listProjects = createTool({
        id: 'listProjects',
        description: 'List all projects (products) with their policies: daily run limit, max attempts, run timeout, paused state.',
        inputSchema: z.object({}),
        execute: async () => s.projects.list(),
    });

    const listRepos = createTool({
        id: 'listRepos',
        description: 'List the GitHub repos of a project: stacks, test commands, concurrency, paused state and manifest sync status.',
        inputSchema: z.object({ projectId: id('project') }),
        execute: async ({ projectId }) => s.repos.listForProject(projectId),
    });

    const listJobs = createTool({
        id: 'listJobs',
        description:
            'List jobs, newest first, optionally filtered by project, repo, feature or status. ' +
            'Set createdBy to "me" to list only jobs created by the current user. Returns status, PR link, last reason and what blocks each job.',
        inputSchema: z.object({
            projectId: id('project').optional(),
            repoId: id('repo').optional(),
            featureId: id('feature').optional(),
            status: z.enum(JOB_STATUSES).optional(),
            createdBy: z.literal('me').optional().describe('Only jobs created by the current user'),
            limit: z.number().int().min(1).max(200).default(25),
        }),
        execute: async ({ limit, ...filter }, { requestContext }) =>
            s.jobs.list({ ...filter, limit }, copilotUser(requestContext)),
    });

    const getJob = createTool({
        id: 'getJob',
        description:
            'Get one job in detail: task, acceptance criteria, status, runs, feedback, the jobs it is blocked by, ' +
            'its revision proposals, the last reason (why it failed, parked or waits) and the PR link. Use this to explain why a job is not running.',
        inputSchema: z.object({ jobId: id('job') }),
        execute: async ({ jobId }) => {
            const [job, revisions] = await Promise.all([s.jobs.getDetail(jobId), s.revisions.listForJob(jobId)]);
            return { ...job, revisions };
        },
    });

    const listFeatures = createTool({
        id: 'listFeatures',
        description: 'List the features of a project (groups of jobs across its repos) with their progress, optionally filtered by status.',
        inputSchema: z.object({ projectId: id('project'), status: z.enum(FEATURE_STATUSES).optional() }),
        execute: async ({ projectId, status }) => s.features.list(projectId, { status }),
    });

    const getFeature = createTool({
        id: 'getFeature',
        description: 'Get one feature: spec, acceptance criteria, status, progress (jobs per status, lead time) and all its jobs.',
        inputSchema: z.object({ featureId: id('feature') }),
        execute: async ({ featureId }) => s.features.getDetail(featureId),
    });

    const listProposals = createTool({
        id: 'listProposals',
        description:
            'List revision proposals that agents made to jobs (changes to a job\'s title, task, criteria or dependencies). ' +
            'Defaults to proposals still waiting for a decision.',
        inputSchema: z.object({ projectId: id('project').optional(), status: z.enum(REVISION_STATUSES).default('proposed') }),
        execute: async (q) => s.revisions.list(q),
    });

    const getDispatchStatus = createTool({
        id: 'getDispatchStatus',
        description:
            'Get the result of the last dispatch pass: per repo whether jobs are being fired, or why not ' +
            '(paused, daily limit reached, no free slots, no routine, waiting on dependencies or proposals). Use this to explain why queued jobs do not start.',
        inputSchema: z.object({}),
        execute: async () => s.dispatcher.status(),
    });

    const getMetrics = createTool({
        id: 'getMetrics',
        description: 'Get throughput and quality metrics (jobs per status, success and retry rates, durations) over a window of days, optionally for one project or repo.',
        inputSchema: z.object({
            days: z.number().int().min(1).max(365).default(30).describe('Window in days'),
            projectId: id('project').optional(),
            repoId: id('repo').optional(),
        }),
        execute: async (q) => s.metrics.get(q),
    });

    const listLessons = createTool({
        id: 'listLessons',
        description: 'List lessons (instructions collected from agent runs and review feedback), optionally by status and project.',
        inputSchema: z.object({ status: z.enum(LESSON_STATUSES).optional(), projectId: id('project').optional() }),
        execute: async (q) => s.lessons.list(q),
    });

    const getRepoSkills = createTool({
        id: 'getRepoSkills',
        description: 'Get the skills of a repo and whether each is in sync with the gildeboek library or has drifted (ok, outdated, missing, orphaned, conflict, repo-owned).',
        inputSchema: z.object({ repoId: id('repo') }),
        execute: async ({ repoId }) => s.skills.forRepo(repoId),
    });

    return { listProjects, listRepos, listJobs, getJob, listFeatures, getFeature, listProposals, getDispatchStatus, getMetrics, listLessons, getRepoSkills };
}

export type CopilotTools = ReturnType<typeof createCopilotTools>;
