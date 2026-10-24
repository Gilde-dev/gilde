/** Response types mirror the DTOs in apps/api/src/**\/*.dto.ts. Dates are ISO strings. */

export const JOB_STATUSES = [
  'queued',
  'dispatched',
  'pr_open',
  'awaiting_review',
  'merged',
  'rejected',
  'parked',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const RUN_STATUSES = [
  'firing',
  'fired',
  'fire_failed',
  'pr_opened',
  'ci_passed',
  'ci_failed',
  'timed_out',
  'superseded',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  dailyRunLimit: number;
  maxAttempts: number;
  runTimeoutMinutes: number;
  retryOnChangesRequested: boolean;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: string;
  projectId: string;
  fullName: string;
  defaultBranch: string;
  stack: string;
  testCommand: string;
  routineFireUrl: string | null;
  routineTokenEnv: string | null;
  maxConcurrentJobs: number;
  paused: boolean;
  pausedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  projectId: string;
  repoId: string;
  title: string;
  task: string;
  acceptanceCriteria: string[];
  status: JobStatus;
  attempts: number;
  queuedAt: string;
  prNumber: number | null;
  prUrl: string | null;
  branch: string | null;
  lastReason: string | null;
  needsApproval: boolean;
  approvalReason: string | null;
  dependsOn: string[];
  /** Dependencies that are not merged yet. */
  blockedBy: BlockingJob[];
  /** Present (true) when any dependency is rejected, parked or cancelled. */
  failedDependency?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BlockingJob {
  id: string;
  title: string;
  status: JobStatus;
}

export interface RunResult {
  outcome: 'done' | 'partial' | 'blocked';
  summary: string;
  testsRun?: boolean;
  testsPassed?: boolean;
  suggestedLesson?: string | null;
}

export interface Run {
  id: string;
  jobId: string;
  projectId: string;
  repoId: string;
  attempt: number;
  status: RunStatus;
  sessionId: string | null;
  sessionUrl: string | null;
  error: string | null;
  ciConclusion: string | null;
  result: RunResult | null;
  retro: string | null;
  firedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Feedback {
  id: string;
  jobId: string;
  projectId: string;
  repoId: string;
  prNumber: number;
  kind: string;
  githubId: string;
  author: string;
  authorAssociation: string;
  state: string | null;
  reviewId: string | null;
  path: string | null;
  line: number | null;
  body: string;
  url: string;
  createdAt: string;
}

export interface JobDetail extends Job {
  runs: Run[];
  feedback: Feedback[];
}

export const API_BASE = (process.env.NEXT_PUBLIC_GILDE_API ?? 'http://localhost:4100/api').replace(/\/+$/, '');

export interface ApiIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The API's own message, without the request prefix. */
    readonly detail?: string,
    /** Per-field validation issues from a 400 response. */
    readonly issues: ApiIssue[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      cache: 'no-store',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(`Could not reach the Gilde API at ${API_BASE}`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    let issues: ApiIssue[] = [];
    try {
      const json = (await res.json()) as { message?: unknown; issues?: unknown };
      if (typeof json.message === 'string') detail = json.message;
      else if (Array.isArray(json.message)) detail = json.message.join(', ');
      if (Array.isArray(json.issues)) {
        issues = json.issues.filter(
          (i): i is ApiIssue => typeof i?.path === 'string' && typeof i?.message === 'string',
        );
      }
    } catch {
      // body wasn't JSON; keep the status text
    }
    throw new ApiError(`${method} ${path} failed: ${res.status} ${detail}`.trim(), res.status, detail, issues);
  }
  return (await res.json()) as T;
}

export interface CreateJobInput {
  title: string;
  task: string;
  acceptanceCriteria: string[];
  dependsOn?: string[];
}

export interface Metrics {
  days: number;
  jobs: { total: number; countByStatus: Record<JobStatus, number> };
  mergeRate: number | null;
  firstPassRate: number | null;
  avgAttempts: number | null;
  /** Minutes from job creation to the last run finishing. */
  timeToMerge: { median: number | null; p90: number | null };
  runs: {
    total: number;
    byOutcome: { done: number; partial: number; blocked: number; none: number };
    byCiConclusion: Record<string, number>;
    gateFailures: number;
  };
  daily: { date: string; created: number; merged: number; parked: number }[];
}

export interface MetricsFilter {
  projectId?: string;
  repoId?: string;
  days: number;
}

export const LESSON_STATUSES = ['candidate', 'approved', 'applying', 'applied', 'rejected'] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];

export const LESSON_TARGET_KINDS = ['skill', 'agents_md', 'routine_prompt', 'other'] as const;
export type LessonTargetKind = (typeof LESSON_TARGET_KINDS)[number];

export interface LessonSource {
  id: string;
  kind: 'suggested_lesson' | 'retro' | 'feedback';
  jobId: string;
  runId: string | null;
  feedbackId: string | null;
  excerpt: string;
  /** PR of the source job, if it has one. */
  prUrl: string | null;
  createdAt: string;
}

export interface Lesson {
  id: string;
  projectId: string;
  text: string;
  status: LessonStatus;
  targetKind: LessonTargetKind | null;
  targetRepoId: string | null;
  note: string | null;
  appliedJobId: string | null;
  /** PR of the job applying the lesson, if it has one. */
  appliedJobPrUrl: string | null;
  appliedAt: string | null;
  sources: LessonSource[];
  /** Number of distinct jobs among the sources. */
  sourceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateLessonInput {
  text?: string;
  targetKind?: LessonTargetKind | null;
  targetRepoId?: string | null;
  note?: string | null;
}

const id = encodeURIComponent;

export const api = {
  listProjects: () => request<Project[]>('/v1/projects'),
  listRepos: (projectId: string) => request<Repo[]>(`/v1/projects/${id(projectId)}/repos`),
  listJobs: (projectId: string) => request<Job[]>(`/v1/jobs?projectId=${id(projectId)}&limit=200`),
  getMetrics: ({ projectId, repoId, days }: MetricsFilter) => {
    const q = new URLSearchParams({ days: String(days) });
    if (projectId) q.set('projectId', projectId);
    if (repoId) q.set('repoId', repoId);
    return request<Metrics>(`/v1/metrics?${q}`);
  },
  listLessons: (projectId: string) => request<Lesson[]>(`/v1/lessons?projectId=${id(projectId)}`),
  collectLessons: () => request<{ created: number }>('/v1/lessons/collect', 'POST'),
  updateLesson: (lessonId: string, input: UpdateLessonInput) =>
    request<Lesson>(`/v1/lessons/${id(lessonId)}`, 'PATCH', input),
  setLessonStatus: (lessonId: string, action: 'approve' | 'reject' | 'reopen') =>
    request<Lesson>(`/v1/lessons/${id(lessonId)}/${action}`, 'POST'),
  applyLesson: (lessonId: string) => request<Lesson>(`/v1/lessons/${id(lessonId)}/apply`, 'POST'),
  markLessonApplied: (lessonId: string) => request<Lesson>(`/v1/lessons/${id(lessonId)}/mark-applied`, 'POST'),
  mergeLessons: (targetId: string, lessonIds: string[]) =>
    request<Lesson>('/v1/lessons/merge', 'POST', { targetId, lessonIds }),
  getJob: (jobId: string) => request<JobDetail>(`/v1/jobs/${id(jobId)}`),
  createJob: (repoId: string, input: CreateJobInput) => request<Job>(`/v1/repos/${id(repoId)}/jobs`, 'POST', input),
  setJobDependencies: (jobId: string, dependsOn: string[]) =>
    request<Job>(`/v1/jobs/${id(jobId)}/dependencies`, 'PUT', { dependsOn }),
  cancelJob: (jobId: string) => request<Job>(`/v1/jobs/${id(jobId)}/cancel`, 'POST'),
  retryJob: (jobId: string) => request<Job>(`/v1/jobs/${id(jobId)}/retry`, 'POST'),
  setRepoPaused: (repoId: string, paused: boolean) =>
    request<Repo>(`/v1/repos/${id(repoId)}/${paused ? 'pause' : 'resume'}`, 'POST'),
  setProjectPaused: (projectId: string, paused: boolean) =>
    request<Project>(`/v1/projects/${id(projectId)}/${paused ? 'pause' : 'resume'}`, 'POST'),
};
