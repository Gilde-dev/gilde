/** Response types mirror the DTOs in apps/api/src/**\/*.dto.ts. Dates are ISO strings. */

export const JOB_STATUSES = [
  'triage',
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

export const SKILLS_LIBRARY_KINDS = ['none', 'folder', 'repo'] as const;
export type SkillsLibraryKind = (typeof SKILLS_LIBRARY_KINDS)[number];

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
  skillsLibrary: SkillsLibraryKind;
  skillsLibraryRepoId: string | null;
  /** Estimated USD per UTC day / ISO week; null = no limit, 0 = stop immediately. */
  dailyBudgetUsd: number | null;
  weeklyBudgetUsd: number | null;
  budgetSoftPct: number;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors UpdateProjectSchema (slug can't change). */
export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  dailyRunLimit?: number;
  maxAttempts?: number;
  runTimeoutMinutes?: number;
  retryOnChangesRequested?: boolean;
  skillsLibrary?: SkillsLibraryKind;
  skillsLibraryRepoId?: string | null;
  /** Finite >= 0; null clears the limit, omitted keeps it. */
  dailyBudgetUsd?: number | null;
  weeklyBudgetUsd?: number | null;
  /** > 0 and <= 100. */
  budgetSoftPct?: number;
}

/** Mirrors CreateProjectSchema. */
export interface CreateProjectInput extends UpdateProjectInput {
  slug: string;
  name: string;
}

export type BudgetScope = 'global' | 'project';
export type BudgetPeriod = 'day' | 'week';
export type BudgetState = 'ok' | 'soft' | 'hard';

/**
 * Why a budget period is soft or hard. `configError`: the named GLOBAL_*_BUDGET_USD variable is set but invalid
 * (never the raw value); a period reset does not clear it, the variable must be corrected.
 */
export interface BudgetReason {
  kind: 'limit' | 'configError';
  variable: string | null;
  message: string;
}

/** empty: no rows; complete: all priced; partial: some unpriced (spent is a lower bound); unknown: rows but none priced. */
export type BudgetPricing = 'empty' | 'complete' | 'partial' | 'unknown';

export interface BudgetPeriodStatus {
  scope: BudgetScope;
  period: BudgetPeriod;
  projectId: string | null;
  startsAt: string;
  resetsAt: string;
  /** Sum of the known estimated costs in USD. */
  spent: number;
  pricedRows: number;
  totalRows: number;
  unpricedRows: number;
  pricing: BudgetPricing;
  incomplete: boolean;
  /** Null = no limit (or an unreadable global configuration, see `reason`). */
  limit: number | null;
  /** Null without a numeric limit and for a limit of 0. */
  percent: number | null;
  softPct: number;
  state: BudgetState;
  reason: BudgetReason | null;
}

export interface BudgetBlocker {
  scope: BudgetScope;
  projectId: string | null;
  period: BudgetPeriod;
  kind: 'limit' | 'configError';
  variable: string | null;
  limit: number | null;
  spent: number;
  startsAt: string;
  resetsAt: string;
  message: string;
}

/** GET /v1/budget?projectId= */
export interface BudgetStatus {
  evaluatedAt: string;
  global: { day: BudgetPeriodStatus; week: BudgetPeriodStatus };
  project: { projectId: string; day: BudgetPeriodStatus; week: BudgetPeriodStatus } | null;
  blockers: BudgetBlocker[];
  hardBlocked: boolean;
  /** reset: `recoversAt` is the latest blocker reset; manual: a configuration/limit change is needed; none: nothing blocks. */
  recovery: 'none' | 'reset' | 'manual';
  recoversAt: string | null;
}

/** Mirrors CreateRepoSchema. */
export interface CreateRepoInput {
  fullName: string;
  defaultBranch?: string;
  routineFireUrl?: string | null;
  /** The NAME of an env var on the API server that holds the routine token; never the token. */
  routineTokenEnv?: string | null;
  maxConcurrentJobs?: number;
}

/** Mirrors UpdateRepoSchema: the full name can't change. */
export type UpdateRepoInput = Partial<Omit<CreateRepoInput, 'fullName'>>;

/** GET /v1/repos/:id/workspace */
export interface RepoWorkspace {
  cloned: boolean;
  headSha: string | null;
  fetchedAt: string | null;
  error: string | null;
}

export const SKILL_STATUSES = ['ok', 'outdated', 'missing', 'orphaned', 'conflict', 'repo'] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

export interface SkillCatalog {
  library: { kind: 'folder' | 'repo'; repoFullName: string | null };
  skills: {
    name: string;
    description: string;
    scope: 'global' | 'stack';
    stacks: string[];
    files: string[];
    repos: { id: string; fullName: string }[];
  }[];
}

export interface RepoSkills {
  repoId: string;
  skills: {
    name: string;
    description: string | null;
    source: 'managed' | 'repo' | null;
    managedBy: string | null;
    status: SkillStatus;
  }[];
  counts: Record<SkillStatus, number>;
}

export const STACKS = ['spring-boot', 'nestjs', 'nextjs', 'node', 'other'] as const;
export type Stack = (typeof STACKS)[number];

export interface PromoteSkillInput {
  scope: 'global' | 'stack';
  stacks?: Stack[];
}

export interface PromoteSkillResult {
  /** Null when the library is a server folder: the skill was written directly. */
  libraryJobId: string | null;
  cleanupJobId: string;
}

export interface Repo {
  id: string;
  projectId: string;
  fullName: string;
  defaultBranch: string;
  routineFireUrl: string | null;
  routineTokenEnv: string | null;
  maxConcurrentJobs: number;
  stacks: string[];
  testCommands: string[];
  skills: { include?: string[]; exclude?: string[] } | null;
  manifestSha: string | null;
  manifestSyncedAt: string | null;
  manifestError: string | null;
  paused: boolean;
  pausedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  projectId: string;
  repoId: string;
  /** The feature this job belongs to, if any. */
  featureId: string | null;
  title: string;
  task: string;
  acceptanceCriteria: string[];
  status: JobStatus;
  attempts: number;
  /** Null while the job is in triage. */
  queuedAt: string | null;
  prNumber: number | null;
  prUrl: string | null;
  branch: string | null;
  lastReason: string | null;
  needsApproval: boolean;
  approvalReason: string | null;
  dependsOn: string[];
  /** Dependencies that are not merged yet. */
  blockedBy: BlockingJob[];
  /** Revisions proposed by agents and waiting for a human. */
  pendingRevisions: number;
  /** Number of the last accepted revision; 0 when never revised. */
  revision: number;
  /** Who created the job; null for system-created jobs. */
  createdBy: { id: string; name: string } | null;
  /** Present (true) when any dependency is rejected, parked or cancelled. */
  failedDependency?: boolean;
  createdAt: string;
  updatedAt: string;
}

export const FEATURE_STATUSES = ['draft', 'active', 'done', 'cancelled'] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export interface FeatureProgress {
  /** Jobs excluding cancelled ones. */
  total: number;
  countByStatus: Record<JobStatus, number>;
  merged: number;
  /** Active, has jobs, and every non-cancelled job is merged. */
  readyToClose: boolean;
  attempts: number;
  /** Minutes from start to done (or to now while active); null before start. */
  leadTimeMinutes: number | null;
}

export interface Feature {
  id: string;
  projectId: string;
  title: string;
  spec: string;
  acceptanceCriteria: string[];
  status: FeatureStatus;
  startedAt: string | null;
  doneAt: string | null;
  progress: FeatureProgress;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureDetail extends Feature {
  jobs: Job[];
  /** Lifetime Claude Code usage of the feature (all attributed requests). */
  agentUsage: AgentTotals;
}

export interface FeatureJobRef {
  id: string;
  title: string;
  status: JobStatus;
}

export interface FeatureStartResult extends Feature {
  warnings: EnqueueWarning[];
}

export interface FeatureDoneResult extends Feature {
  /** Jobs that are not merged, rejected or cancelled. */
  openJobs: FeatureJobRef[];
}

export interface FeatureCancelResult extends Feature {
  cancelledJobs: FeatureJobRef[];
  /** Jobs left alone: in flight or parked. */
  activeJobs: FeatureJobRef[];
}

export type FeatureActionResult = FeatureStartResult | FeatureDoneResult | FeatureCancelResult | Feature;

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
  instructionsVersion: string | null;
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

export const REVISION_STATUSES = ['proposed', 'accepted', 'rejected'] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];

/** A change to a job proposed by an agent; null content fields mean unchanged. */
export interface Revision {
  id: string;
  jobId: string;
  /** Assigned when accepted. */
  revision: number | null;
  title: string | null;
  task: string | null;
  acceptanceCriteria: string[] | null;
  dependsOn: string[] | null;
  reason: string;
  sourceRunId: string | null;
  status: RevisionStatus;
  decidedAt: string | null;
  createdAt: string;
  /** The job as it is now, to diff against. */
  job: {
    id: string;
    title: string;
    task: string;
    acceptanceCriteria: string[];
    dependsOn: string[];
    status: JobStatus;
  };
  /** PR of the run that proposed it. */
  pr: { number: number; url: string } | null;
}

export interface JobPrompt {
  text: string;
  instructionsVersion: string | null;
}

export interface JobDetail extends Job {
  runs: (Run & { agentUsage: AgentTotals })[];
  /** Lifetime Claude Code usage of the job. */
  agentUsage: AgentTotals;
  feedback: Feedback[];
}

/** Same-origin server-side proxy; it adds the token from the httpOnly session cookie. */
export const API_BASE = '/api/gilde';

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/** Returned once, on creation: `key` is never shown again. */
export interface CreatedApiKey {
  id: string;
  name: string;
  prefix: string;
  key: string;
  expiresAt: string | null;
}

export interface ApiIssue {
  path: string;
  message: string;
}

/** GET /v1/copilot/status: the co-pilot is enabled when an OpenAI key and model are configured. */
export interface CopilotStatus {
  enabled: boolean;
  model: string | null;
  /** The unattended scout (Verkenner), configured separately from the co-pilot. */
  scout: { enabled: boolean; model: string | null };
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

async function request<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'GET', body?: unknown): Promise<T> {
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
  if (res.status === 401 && typeof window !== 'undefined' && window.location.pathname !== '/login') {
    const here = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/login?next=${encodeURIComponent(here)}`);
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
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface CreateJobInput {
  title: string;
  task: string;
  acceptanceCriteria: string[];
  dependsOn?: string[];
  status?: 'triage' | 'queued';
  featureId?: string;
}

export interface UpdateJobInput {
  title?: string;
  task?: string;
  acceptanceCriteria?: string[];
  featureId?: string | null;
}

export interface CreateFeatureInput {
  title: string;
  spec?: string;
  acceptanceCriteria?: string[];
}

export interface UpdateFeatureInput {
  title?: string;
  spec?: string;
  acceptanceCriteria?: string[];
}

export interface EnqueueWarning {
  dependencyId: string;
  message: string;
}

export interface EnqueueResult extends Job {
  warnings: EnqueueWarning[];
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
  byInstructionsVersion: {
    /** "none" for runs fired without instructions. */
    version: string;
    runs: number;
    mergedJobs: number;
    firstPassRate: number | null;
    avgAttempts: number | null;
  }[];
  daily: { date: string; created: number; merged: number; parked: number }[];
}

export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** Null when no row in the group has a known price. */
  costUsd: number | null;
  runs: number;
}

/** Claude Code usage: co-pilot keys plus cacheCreationTokens. `costUsd` sums Claude Code's own estimates (notional under a subscription). */
export interface AgentTotals extends UsageTotals {
  cacheCreationTokens: number;
  uncachedInputTokens: number;
  /** Requests without a cost estimate; `costUsd` is partial when > 0 and < runs. */
  costUnknownRequests: number;
  costPartial: boolean;
}

export interface AgentUsage {
  days: number;
  scope: 'global' | 'project';
  projectId: string | null;
  totals: AgentTotals;
  daily: (AgentTotals & { date: string })[];
  byModel: (AgentTotals & { model: string })[];
  byRepo: (AgentTotals & { repoId: string; fullName: string | null })[];
  byFeature: (AgentTotals & { featureId: string; title: string | null })[];
  /** Rows not matched to a run (unknown project); global scope only. */
  unattributed: AgentTotals;
}

export interface Usage {
  days: number;
  totals: UsageTotals;
  daily: (UsageTotals & { date: string })[];
  byModel: (UsageTotals & { model: string })[];
  byKind: (UsageTotals & { kind: 'chat' | 'embedding' })[];
  byUser: (UsageTotals & { userId: string | null; userName: string | null })[];
}

export interface MetricsFilter {
  projectId?: string;
  repoId?: string;
  days: number;
}

export const LESSON_STATUSES = ['candidate', 'approved', 'applying', 'applied', 'rejected'] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];

/** The kinds the UI offers. */
export const LESSON_TARGET_KINDS = ['agents_md', 'repo_skill', 'routine_prompt', 'other'] as const;
/** `skill` is a legacy value on old rows: it behaves like repo_skill and can no longer be set. */
export type LessonTargetKind = (typeof LESSON_TARGET_KINDS)[number] | 'skill';

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
  targetKind?: Exclude<LessonTargetKind, 'skill'> | null;
  targetRepoId?: string | null;
  note?: string | null;
}

export type DispatchReason =
  | 'repo_paused' | 'project_paused' | 'no_routine' | 'no_manifest' | 'no_slots' | 'daily_limit' | 'none';

export interface RepoDispatchReport {
  repoId: string;
  fullName: string;
  queued: number;
  fired: number;
  reason: DispatchReason;
  detail: string | null;
  /** Next UTC midnight (ISO) when the reason is daily_limit. */
  resetsAt: string | null;
  waitingOnDependencies: number;
  waitingOnRevisions: number;
}

export interface DispatchStatus {
  at: string | null;
  result: { fired: number; failed: number; repos: RepoDispatchReport[] } | null;
}

const id = encodeURIComponent;

export const api = {
  me: () => request<CurrentUser>('/v1/auth/me'),
  listApiKeys: () => request<ApiKey[]>('/v1/api-keys'),
  createApiKey: (input: { name: string; expiresInDays?: number }) =>
    request<CreatedApiKey>('/v1/api-keys', 'POST', input),
  revokeApiKey: (keyId: string) => request<void>(`/v1/api-keys/${id(keyId)}`, 'DELETE'),
  listProjects: () => request<Project[]>('/v1/projects'),
  copilotStatus: () => request<CopilotStatus>('/v1/copilot/status'),
  listRepos: (projectId: string) => request<Repo[]>(`/v1/projects/${id(projectId)}/repos`),
  listJobs: (projectId: string, createdBy?: 'me') =>
    request<Job[]>(`/v1/jobs?projectId=${id(projectId)}&limit=200${createdBy ? `&createdBy=${createdBy}` : ''}`),
  getMetrics: ({ projectId, repoId, days }: MetricsFilter) => {
    const q = new URLSearchParams({ days: String(days) });
    if (projectId) q.set('projectId', projectId);
    if (repoId) q.set('repoId', repoId);
    return request<Metrics>(`/v1/metrics?${q}`);
  },
  getUsage: (days: number) => request<Usage>(`/v1/usage?days=${days}`),
  getAgentUsage: (days: number, projectId?: string) =>
    request<AgentUsage>(`/v1/usage/agents?days=${days}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`),
  getDispatchStatus: () => request<DispatchStatus>('/v1/dispatch/status'),
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
  listFeatures: (projectId: string, status?: FeatureStatus) =>
    request<Feature[]>(`/v1/projects/${id(projectId)}/features${status ? `?status=${status}` : ''}`),
  createFeature: (projectId: string, input: CreateFeatureInput) =>
    request<Feature>(`/v1/projects/${id(projectId)}/features`, 'POST', input),
  getFeature: (featureId: string) => request<FeatureDetail>(`/v1/features/${id(featureId)}`),
  updateFeature: (featureId: string, input: UpdateFeatureInput) =>
    request<Feature>(`/v1/features/${id(featureId)}`, 'PATCH', input),
  startFeature: (featureId: string) => request<FeatureStartResult>(`/v1/features/${id(featureId)}/start`, 'POST'),
  doneFeature: (featureId: string) => request<FeatureDoneResult>(`/v1/features/${id(featureId)}/done`, 'POST'),
  cancelFeature: (featureId: string) => request<FeatureCancelResult>(`/v1/features/${id(featureId)}/cancel`, 'POST'),
  reopenFeature: (featureId: string) => request<Feature>(`/v1/features/${id(featureId)}/reopen`, 'POST'),
  listRevisions: (status?: RevisionStatus, projectId?: string) => {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (projectId) q.set('projectId', projectId);
    return request<Revision[]>(`/v1/revisions?${q}`);
  },
  listJobRevisions: (jobId: string) => request<Revision[]>(`/v1/jobs/${id(jobId)}/revisions`),
  acceptRevision: (revisionId: string) => request<Revision>(`/v1/revisions/${id(revisionId)}/accept`, 'POST'),
  rejectRevision: (revisionId: string) => request<Revision>(`/v1/revisions/${id(revisionId)}/reject`, 'POST'),
  getJob: (jobId: string) => request<JobDetail>(`/v1/jobs/${id(jobId)}`),
  getJobPrompt: (jobId: string) => request<JobPrompt>(`/v1/jobs/${id(jobId)}/prompt`),
  createJob: (repoId: string, input: CreateJobInput) => request<Job>(`/v1/repos/${id(repoId)}/jobs`, 'POST', input),
  setJobDependencies: (jobId: string, dependsOn: string[]) =>
    request<Job>(`/v1/jobs/${id(jobId)}/dependencies`, 'PUT', { dependsOn }),
  updateJob: (jobId: string, input: UpdateJobInput) => request<Job>(`/v1/jobs/${id(jobId)}`, 'PATCH', input),
  enqueueJob: (jobId: string) => request<EnqueueResult>(`/v1/jobs/${id(jobId)}/enqueue`, 'POST'),
  triageJob: (jobId: string) => request<Job>(`/v1/jobs/${id(jobId)}/triage`, 'POST'),
  enqueueJobs: (ids: string[]) => request<EnqueueResult[]>('/v1/jobs/enqueue', 'POST', { ids }),
  cancelJob: (jobId: string) => request<Job>(`/v1/jobs/${id(jobId)}/cancel`, 'POST'),
  retryJob: (jobId: string) => request<Job>(`/v1/jobs/${id(jobId)}/retry`, 'POST'),
  sendBackJob: (jobId: string, reason: string) => request<Job>(`/v1/jobs/${id(jobId)}/send-back`, 'POST', { reason }),
  setRepoPaused: (repoId: string, paused: boolean) =>
    request<Repo>(`/v1/repos/${id(repoId)}/${paused ? 'pause' : 'resume'}`, 'POST'),
  refreshRepoManifest: (repoId: string) => request<Repo>(`/v1/repos/${id(repoId)}/manifest/refresh`, 'POST'),
  createProject: (input: CreateProjectInput) => request<Project>('/v1/projects', 'POST', input),
  getBudget: (projectId?: string) => request<BudgetStatus>(`/v1/budget${projectId ? `?projectId=${id(projectId)}` : ''}`),
  getProject: (projectId: string) => request<Project>(`/v1/projects/${id(projectId)}`),
  createRepo: (projectId: string, input: CreateRepoInput) =>
    request<Repo>(`/v1/projects/${id(projectId)}/repos`, 'POST', input),
  getRepo: (repoId: string) => request<Repo>(`/v1/repos/${id(repoId)}`),
  updateRepo: (repoId: string, input: UpdateRepoInput) => request<Repo>(`/v1/repos/${id(repoId)}`, 'PATCH', input),
  getRepoWorkspace: (repoId: string) => request<RepoWorkspace>(`/v1/repos/${id(repoId)}/workspace`),
  updateProject: (projectId: string, input: UpdateProjectInput) =>
    request<Project>(`/v1/projects/${id(projectId)}`, 'PATCH', input),
  getSkillCatalog: (projectId: string) => request<SkillCatalog>(`/v1/projects/${id(projectId)}/skills`),
  refreshSkillCatalog: (projectId: string) => request<SkillCatalog>(`/v1/projects/${id(projectId)}/skills/refresh`, 'POST'),
  getRepoSkills: (repoId: string) => request<RepoSkills>(`/v1/repos/${id(repoId)}/skills`),
  promoteSkill: (repoId: string, name: string, input: PromoteSkillInput) =>
    request<PromoteSkillResult>(`/v1/repos/${id(repoId)}/skills/${id(name)}/promote`, 'POST', input),
  setProjectPaused: (projectId: string, paused: boolean) =>
    request<Project>(`/v1/projects/${id(projectId)}/${paused ? 'pause' : 'resume'}`, 'POST'),
};
