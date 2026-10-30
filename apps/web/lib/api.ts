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
  /** Start one automatic conflict-fix round per PR head when an agent PR gets merge conflicts. */
  autoFixConflicts: boolean;
  /** Queue a Werkmeester planning run when a spec version is approved. */
  autoPlan: boolean;
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

/**
 * Mirrors ReplaceProjectSchema: PUT replaces every updatable field, so all keys are required (slug and paused are not
 * part of it). Build it with `projectReplacement` from the latest loaded project.
 */
export interface ReplaceProjectInput {
  name: string;
  description: string | null;
  dailyRunLimit: number;
  maxAttempts: number;
  runTimeoutMinutes: number;
  retryOnChangesRequested: boolean;
  autoFixConflicts: boolean;
  autoPlan: boolean;
  skillsLibrary: SkillsLibraryKind;
  skillsLibraryRepoId: string | null;
  /** Finite >= 0; null clears the limit (no limit), 0 stops dispatch immediately. */
  dailyBudgetUsd: number | null;
  weeklyBudgetUsd: number | null;
  /** > 0 and <= 100. */
  budgetSoftPct: number;
}

/** Mirrors CreateProjectSchema: everything but slug and name is optional. */
export interface CreateProjectInput extends Partial<ReplaceProjectInput> {
  slug: string;
  name: string;
}

/** `base` with the keys of `edits` that are not undefined; undefined never reaches a request body. */
function overlay<T extends object>(base: T, edits: Partial<T>): T {
  const out = { ...base };
  for (const key of Object.keys(edits) as (keyof T)[]) {
    if (edits[key] !== undefined) out[key] = edits[key] as T[keyof T];
  }
  return out;
}

/** The updatable fields of a loaded project with the user's edits on top. */
export function projectReplacement(p: Project, edits: Partial<ReplaceProjectInput> = {}): ReplaceProjectInput {
  return overlay<ReplaceProjectInput>(
    {
      name: p.name,
      description: p.description,
      dailyRunLimit: p.dailyRunLimit,
      maxAttempts: p.maxAttempts,
      runTimeoutMinutes: p.runTimeoutMinutes,
      retryOnChangesRequested: p.retryOnChangesRequested,
      autoFixConflicts: p.autoFixConflicts,
      autoPlan: p.autoPlan,
      skillsLibrary: p.skillsLibrary,
      skillsLibraryRepoId: p.skillsLibraryRepoId,
      dailyBudgetUsd: p.dailyBudgetUsd,
      weeklyBudgetUsd: p.weeklyBudgetUsd,
      budgetSoftPct: p.budgetSoftPct,
    },
    edits,
  );
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
  maxConcurrentJobs?: number;
}

/** Mirrors ReplaceRepoSchema: every key is required; the full name can't change. Capacity comes from personal executors, not the repo. */
export interface ReplaceRepoInput {
  defaultBranch: string;
  maxConcurrentJobs: number;
}

/** The updatable fields of a loaded repo with the user's edits on top. */
export function repoReplacement(r: Repo, edits: Partial<ReplaceRepoInput> = {}): ReplaceRepoInput {
  return overlay<ReplaceRepoInput>(
    { defaultBranch: r.defaultBranch, maxConcurrentJobs: r.maxConcurrentJobs },
    edits,
  );
}

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

export interface ImpactGroup {
  n: number;
  insufficient: boolean;
  counts: { done: number; partial: number; blocked: number; merged: number; rejectedOrParked: number; ciFailed: number };
  /** Null when `insufficient`. */
  rates: { done: number; partial: number; blocked: number; merged: number; rejectedOrParked: number; ciFailed: number } | null;
  avgRevisionRounds: number | null;
  medianTokens: number | null;
  tokensN: number;
}

export interface SkillVersionImpact {
  hash: string;
  managedBy: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  with: ImpactGroup;
  without: ImpactGroup;
}

export interface SkillImpact {
  days: number;
  minRuns: number;
  skills: { name: string; versions: SkillVersionImpact[] }[];
}

export const SKILL_IMPACT_DAYS = [7, 30, 90, 180] as const;

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
  /** Whether the Gilde GitHub App is installed on the repo; null until an installation event was seen. */
  githubAppInstalled: boolean | null;
  /** Set when app mode is active and the app lost its installation on this repo. */
  githubAppWarning: string | null;
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
  /** Whose executors may run the job: the non-bot creator, otherwise the human who queued it; null when unknown. */
  ownerId: string | null;
  /** Why a queued job is not being fired: 'no executor', 'executor busy', 'executor limit reached' or 'executor exhausted until <ISO time>'. */
  waitingReason: string | null;
  /** Present (true) when any dependency is rejected, parked, cancelled or merged without work. */
  failedDependency?: boolean;
  /** GitHub says the open PR conflicts with its base branch (set by Gilde, read-only). */
  mergeConflict: boolean;
  /** When GitHub last gave a definite mergeable answer; null before the first. */
  mergeConflictCheckedAt: string | null;
  /** Merged on GitHub, but the latest run reported blocked: no work was done and it does not satisfy dependencies. */
  mergedBlocked: boolean;
  /** The job created by "Recreate job" to replace this one. */
  replacedById: string | null;
  /** The merged-without-work job this one was recreated from. */
  recreatedFromId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const SPEC_STATUSES = ['draft', 'approved'] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

export interface SpecCriterion {
  number: number;
  id: string;
  text: string;
}

export interface SpecApprovalEvidence {
  id: string;
  approvedById: string | null;
  approvedByName: string;
  approvedByEmail: string;
  approvedAt: string;
}

export const RECORDING_STATES = ['triage', 'queued', 'in_flight', 'recorded', 'failed', 'superseded'] as const;
export type SpecRecordingState = (typeof RECORDING_STATES)[number];

export interface SpecRecording {
  id: string;
  jobId: string;
  jobStatus: JobStatus;
  jobTitle: string;
  prUrl: string | null;
  state: SpecRecordingState;
  mergedWithoutWork: boolean;
  dependsOnJobId: string | null;
  supersededByRecordingId: string | null;
  supersededAt: string | null;
  pinnedByFeatureId: string | null;
  createdAt: string;
}

export const PLANNING_RUN_STATUSES = ['queued', 'running', 'planned', 'skipped', 'failed'] as const;
export type PlanningRunStatus = (typeof PLANNING_RUN_STATUSES)[number];

/** One request for the Werkmeester to plan an approved version; the latest per version is on the version. */
export interface SpecPlanningRun {
  id: string;
  version: number;
  status: PlanningRunStatus;
  attempts: number;
  /** Set when planned (or skipped because the version already has a feature). */
  featureId: string | null;
  /** Short reason of a skipped or failed run. */
  reason: string | null;
  trigger: 'auto' | 'manual';
  requestedById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpecEligibility {
  eligible: boolean;
  reasons: string[];
}

export interface SpecVersion {
  id: string;
  version: number;
  title: string;
  /** Exactly the bytes that were saved. */
  body: string;
  bodySha256: string;
  criteria: SpecCriterion[];
  createdById: string | null;
  createdAt: string;
  eligibility: SpecEligibility;
  approval: SpecApprovalEvidence | null;
  recording: SpecRecording | null;
  /** The latest planning run of this version; null when none was requested. */
  planning: SpecPlanningRun | null;
}

/** The external issue a spec was drafted from; null for specs written by hand. */
export interface SpecSource {
  kind: 'github_issue';
  url: string;
  number: number;
}

export interface Spec {
  id: string;
  projectId: string;
  repoId: string;
  slug: string;
  title: string;
  status: SpecStatus;
  currentVersion: number;
  approvedVersion: number | null;
  createdById: string | null;
  updatedById: string | null;
  approvedById: string | null;
  approvedAt: string | null;
  /** Set while the spec is archived: hidden from the default list. */
  archivedAt: string | null;
  archivedById: string | null;
  createdAt: string;
  updatedAt: string;
  source: SpecSource | null;
  /** Why a newer approved version was not planned ("v3 approved; feature X is pinned to v2"); null when there is none. */
  planNote: string | null;
}

export interface SpecDetail extends Spec {
  /** Whether the calling user is a verified human who may approve (not whether the current version is eligible). */
  mayApprove: boolean;
  mayApproveReasons: string[];
  eligibility: SpecEligibility;
  /** Newest first. */
  versions: SpecVersion[];
}

export const INTAKE_STATUSES = ['new', 'refining', 'drafted', 'failed', 'withdrawn', 'ignored'] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

/** The spec an intake item was drafted into: approval state and open questions of its current version. */
export interface IntakeSpecSummary {
  id: string;
  slug: string;
  title: string;
  status: SpecStatus;
  currentVersion: number;
  approvedVersion: number | null;
  archivedAt: string | null;
  openQuestions: number;
}

/** A labelled GitHub issue waiting to become, or already turned into, a draft spec. */
export interface IntakeItem {
  id: string;
  projectId: string;
  repoId: string;
  repoFullName: string | null;
  source: 'github_issue';
  externalId: string;
  number: number;
  url: string;
  title: string;
  authorLogin: string | null;
  labels: string[];
  status: IntakeStatus;
  specId: string | null;
  spec: IntakeSpecSummary | null;
  lastError: string | null;
  /** Link to Gilde's status comment on the issue, once posted. */
  statusCommentUrl: string | null;
  /** Why the status comment could not be written (short, safe). */
  commentError: string | null;
  /** Trusted member comments stored as answers for the Verfijner. */
  commentCount: number;
  refineAttempts: number;
  /** Set while the item is archived: hidden from the default list, not refined, no status comment updates. */
  archivedAt: string | null;
  archivedById: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A stored member comment as the Verfijner sees it (same order, same 4000-character cap). */
export interface IntakeComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  /** The comment on GitHub. */
  url: string;
}

export interface IntakeItemDetail extends IntakeItem {
  comments: IntakeComment[];
}

export interface IntakeSweepResult {
  repos: number;
  skipped: number;
  upserted: number;
  withdrawn: number;
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

/** The approved spec version a feature was planned from: the stored snapshot, never the latest draft. */
export interface PinnedSpec {
  specId: string;
  specVersionId: string;
  version: number;
  slug: string;
  title: string;
  repoId: string;
  repoFullName: string;
  /** docs/specs/<slug>.md in that repo. */
  path: string;
  bodySha256: string;
  approvalId: string;
  approvedAt: string;
  approvedByName: string;
  recordingId: string;
  recordingJobId: string;
  recordingJobTitle: string;
}

export interface Feature {
  id: string;
  projectId: string;
  title: string;
  spec: string;
  acceptanceCriteria: string[];
  /** Null for features without a spec. */
  pinnedSpec: PinnedSpec | null;
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
  /** Merged without work: still blocks the job. */
  mergedBlocked?: boolean;
}

export interface RunResult {
  outcome: 'done' | 'partial' | 'blocked';
  summary: string;
  testsRun?: boolean;
  testsPassed?: boolean;
  suggestedLesson?: string | null;
}

/** Name and owner of the executor of a run, never its token. */
export interface RunExecutor {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
}

/** What the agent had when its run was fired, read from the repo's default branch. */
export interface RunContext {
  gildeboekVersion: string | null;
  skills: { name: string; hash: string; managedBy: string | null }[];
  agentsMdHash: string | null;
  capturedAt: string;
}

/** An MCP server that put snippets in a run's prompt; `chars` is the snippet text without delimiters. */
export interface RunKnowledge {
  server: string;
  snippets: number;
  chars: number;
}

export interface Run {
  id: string;
  jobId: string;
  projectId: string;
  repoId: string;
  attempt: number;
  /** The executor that ran the attempt; null for runs from before personal executors. */
  executorId: string | null;
  status: RunStatus;
  sessionId: string | null;
  sessionUrl: string | null;
  instructionsVersion: string | null;
  /** Null for runs from before it was recorded, or when capturing failed (see contextError). */
  context: RunContext | null;
  contextError: string | null;
  /** MCP servers whose knowledge snippets were in the prompt. */
  knowledge: RunKnowledge[];
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

/** What was cut from the optional context of a prompt; absent fields are unchanged. */
export interface PromptTrimmed {
  lessonsRemoved?: string[];
  /** Characters kept per downstream task, or 'title-only' when the task text was left out (criteria are kept). */
  downstreamTaskCap?: number | 'title-only';
  /** Downstream jobs left out by the initial 20-job cutoff. */
  downstreamOmitted?: number;
  downstreamRemoved?: string[];
  /** Knowledge snippets left out, lowest ranked first. */
  knowledgeRemoved?: number;
  featureSpecCap?: number;
}

export interface JobPrompt {
  /** Exactly what a fire would send; a fire refuses it when `length` is over `limit`. */
  text: string;
  instructionsVersion: string | null;
  length: number;
  limit: number;
  trimmed: PromptTrimmed | null;
}

export interface JobDetail extends Job {
  runs: (Run & { agentUsage: AgentTotals; executor: RunExecutor | null })[];
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

export interface JobSyncState {
  status: JobStatus;
  prNumber: number | null;
  headSha: string | null;
  needsApproval: boolean;
}

/** `before` and `after` are the job's state when the check started and ended; `changes` is empty when nothing changed. */
export interface JobSyncResult {
  jobId: string;
  pr: { number: number; state: 'open' | 'closed'; merged: boolean; headSha: string } | null;
  ciConclusion: string | null;
  before: JobSyncState;
  after: JobSyncState;
  changes: string[];
}

export interface ReconcileResult {
  checked: number;
  corrected: number;
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
  scout: { enabled: boolean; model: string | null; disabledReason: string | null };
  /** The unattended refine agent (Verfijner) that drafts specs from intake items; off means items stay `new`. */
  refine: { enabled: boolean; model: string | null };
}

/** GET /v1/copilot/threads: one of the caller's own co-pilot conversations. */
export interface CopilotThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** One message of a conversation, in the shape the chat takes as history (AG-UI). */
export interface CopilotThreadMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolCallId?: string;
}

/** GET /v1/copilot/threads/:id/messages */
export interface CopilotThreadMessages {
  thread: CopilotThread;
  messages: CopilotThreadMessage[];
}

/**
 * GET /v1/copilot/scout-activity?projectId=: what the scout did in one project. Counts cover the project's whole history
 * (not the board's loaded list) and stay visible while the scout is off. `scoutUserId` is the configured scout user, for
 * comparing with a job's creator; it is set whenever that user resolves, also while the scout is off.
 */
export interface ScoutActivity {
  projectId: string;
  enabled: boolean;
  model: string | null;
  scoutUserId: string | null;
  /** Why the scout is off although SCOUT_ENABLED=true (e.g. SCOUT_USER_EMAIL is not a bot account); null otherwise. */
  disabledReason: string | null;
  /** Suggestions since Monday 00:00 UTC of the current week. */
  suggestionsThisWeek: number;
  /** The UTC day (YYYY-MM-DD) of that Monday. */
  weekStart: string;
  /** The actual most recent wake; null if the scout never woke in this project. */
  lastWakeAt: string | null;
}

export interface Executor {
  id: string;
  ownerId: string;
  name: string;
  kind: 'routine';
  fireUrl: string;
  hasToken: boolean;
  /** Last four characters of the token; the token itself is never returned. */
  tokenLast4: string | null;
  repoIds: string[];
  maxConcurrent: number;
  dailyRunLimit: number | null;
  enabled: boolean;
  exhaustedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateExecutorInput {
  name: string;
  fireUrl: string;
  token: string;
  repoIds: string[];
  maxConcurrent?: number;
  dailyRunLimit?: number | null;
  enabled?: boolean;
}

/** Full PUT body: every non-secret updatable field. */
export type ReplaceExecutorInput = Pick<Executor, 'name' | 'fireUrl' | 'repoIds' | 'maxConcurrent' | 'dailyRunLimit' | 'enabled'>;

export function executorReplacement(e: Executor, changes: Partial<ReplaceExecutorInput> = {}): ReplaceExecutorInput {
  return {
    name: e.name,
    fireUrl: e.fireUrl,
    repoIds: e.repoIds,
    maxConcurrent: e.maxConcurrent,
    dailyRunLimit: e.dailyRunLimit,
    enabled: e.enabled,
    ...changes,
  };
}

export type McpToolMode = 'read' | 'write';
export const MCP_AUDIT_ACTIONS = ['created', 'updated', 'token_replaced', 'tested', 'tools_updated', 'deleted'] as const;
export type McpAuditAction = (typeof MCP_AUDIT_ACTIONS)[number];

/** A project's MCP server. The token is never returned, only its last four characters. */
export interface McpServer {
  id: string;
  projectId: string;
  name: string;
  url: string;
  hasToken: boolean;
  tokenLast4: string | null;
  enabled: boolean;
  unattendedEnabled: boolean;
  /** Dispatch queries `knowledgeTool` (an allowed read tool) with the job text and adds the snippets to the payload. */
  knowledgeEnabled: boolean;
  knowledgeTool: string | null;
  knowledgeQueryArg: string | null;
  lastTestedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  callCount: number;
  errorCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface McpTool {
  name: string;
  description: string;
  mode: McpToolMode;
  allowed: boolean;
}

export interface McpAuditEntry {
  id: string;
  serverId: string;
  serverName: string;
  actorId: string;
  actorEmail: string;
  action: McpAuditAction;
  changes: Record<string, unknown>;
  createdAt: string;
}

export interface McpServerDetail extends McpServer {
  tools: McpTool[];
  audit: McpAuditEntry[];
}

export interface McpTestResult {
  ok: boolean;
  errorKind: 'unreachable' | 'timeout' | 'auth' | 'not_mcp' | null;
  message: string | null;
  tools: McpTool[];
}

export interface CreateMcpServerInput {
  name: string;
  url: string;
  token?: string;
  enabled?: boolean;
  unattendedEnabled?: boolean;
}

/** Full PUT body: every non-secret updatable field. */
export type ReplaceMcpServerInput = Pick<
  McpServer,
  'name' | 'url' | 'enabled' | 'unattendedEnabled' | 'knowledgeEnabled' | 'knowledgeTool' | 'knowledgeQueryArg'
>;

export function mcpServerReplacement(s: McpServer, changes: Partial<ReplaceMcpServerInput> = {}): ReplaceMcpServerInput {
  return {
    name: s.name,
    url: s.url,
    enabled: s.enabled,
    unattendedEnabled: s.unattendedEnabled,
    knowledgeEnabled: s.knowledgeEnabled,
    knowledgeTool: s.knowledgeTool,
    knowledgeQueryArg: s.knowledgeQueryArg,
    ...changes,
  };
}

export const AGENT_IDS = ['gilde', 'verkenner', 'verfijner', 'werkmeester', 'mcp', 'coding'] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export const AGENT_STATUSES = ['on', 'off', 'misconfigured', 'disabled_by_env'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export interface AgentBotUser {
  id: string;
  name: string;
  email: string;
}

export interface AgentSettingField {
  key: string;
  label: string;
  kind: 'int' | 'number';
  min: number;
  max: number;
  default: number;
}

export interface Agent {
  id: AgentId;
  label: string;
  status: AgentStatus;
  reason: string | null;
  enabled: boolean;
  model: string | null;
  effectiveModel: string | null;
  hasModel: boolean;
  hasBotUser: boolean;
  botUserId: string | null;
  botUser: AgentBotUser | null;
  settings: Record<string, number>;
  fields: AgentSettingField[];
  updatedAt: string;
}

/** Mirrors ReplaceAgentSettingsSchema: PUT replaces everything, so build it with `agentReplacement` from the latest loaded agent. */
export interface ReplaceAgentSettingsInput {
  enabled: boolean;
  botUserId: string | null;
  model: string | null;
  settings: Record<string, number>;
}

export function agentReplacement(a: Agent, changes: Partial<ReplaceAgentSettingsInput> = {}): ReplaceAgentSettingsInput {
  return { enabled: a.enabled, botUserId: a.botUserId, model: a.model, settings: a.settings, ...changes };
}

export interface AgentAuditEntry {
  id: string;
  agent: AgentId;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedBy: { id: string; name: string | null; email: string | null };
  createdAt: string;
}

export interface AgentTool {
  name: string;
  description: string;
  access: 'read' | 'write';
  needsApproval: boolean;
}

export interface AgentProjectTools {
  projectId: string;
  projectName: string;
  servers: { serverId: string; serverName: string; tools: { name: string; mode: McpToolMode; needsApproval: boolean }[] }[];
}

export interface AgentTools {
  agent: AgentId;
  kind: 'allowlist' | 'routine';
  tools: AgentTool[];
  note: string | null;
  projectTools: AgentProjectTools[];
}

export interface SlackBot {
  id: 'slack';
  label: string;
  status: 'on' | 'off';
  reason: string;
  botUsers: (AgentBotUser & { lastUsedAt: string | null })[];
  notificationKinds: string[];
}

export type AgentRunTrigger = 'chat' | 'signal' | 'schedule' | 'intake_item' | 'spec_version' | 'dispatch' | 'mcp_call';
export type AgentRunOutcome = 'ok' | 'error' | 'refused' | 'skipped';
export const AGENT_RUN_TRIGGERS: readonly AgentRunTrigger[] = ['chat', 'signal', 'schedule', 'intake_item', 'spec_version', 'dispatch', 'mcp_call'];
export const AGENT_RUN_OUTCOMES: readonly AgentRunOutcome[] = ['ok', 'error', 'refused', 'skipped'];

/** Mirrors AgentRunSchema. Another user's co-pilot run has `metadataOnly` and no trigger reference or reason. */
export interface AgentRunSummary {
  id: string;
  agentId: string;
  triggerKind: AgentRunTrigger;
  triggerRefType: string | null;
  triggerRefId: string | null;
  actorUserId: string | null;
  projectId: string | null;
  startedAt: string;
  endedAt: string | null;
  outcome: AgentRunOutcome | null;
  reason: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  linkedTable: string | null;
  linkedId: string | null;
  toolCallCount: number;
  executor: { id: string; name: string } | null;
  metadataOnly: boolean;
}

export interface AgentRunPage {
  items: AgentRunSummary[];
  page: number;
  pageSize: number;
  total: number;
}

/** Recorded content: show it as text only. */
export interface AgentToolCall {
  id: string;
  toolName: string;
  input: string | null;
  output: string | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

export interface AgentRunDetail extends AgentRunSummary {
  toolCalls: AgentToolCall[];
}

export interface AgentRunsParams {
  trigger?: AgentRunTrigger;
  outcome?: AgentRunOutcome;
  projectId?: string;
  executorId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export function agentRunsQuery(params: AgentRunsParams = {}): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') q.set(key, String(value));
  const text = q.toString();
  return text ? `?${text}` : '';
}

export interface PromptText {
  label: string;
  text: string;
  version: string;
  length: number;
}

export interface AgentPrompt {
  agent: string;
  kind: 'instructions' | 'none';
  exampleBinding: string | null;
  instructions: PromptText | null;
  runPrompt: PromptText | null;
  file: { path: string; url: string | null; ref: string; refKind: 'commit' | 'branch'; refSource: string } | null;
  settings: Record<string, number>;
  coding: {
    instructionsPath: string | null;
    loadError: string | null;
    limit: number;
    layout: string[];
    payloadKeys: string[];
    limits: string[];
    trimmingOrder: string[];
  } | null;
  note: string | null;
}

export interface SlackDelivery {
  id: string;
  kind: string;
  title: string;
  projectId: string | null;
  jobId: string | null;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  lastError: string | null;
  occurredAt: string;
  deliveredAt: string | null;
}

export interface SlackDeliveryPage {
  items: SlackDelivery[];
  page: number;
  pageSize: number;
  total: number;
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

async function request<T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: unknown): Promise<T> {
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

/** Mirrors ReplaceJobSchema: every key is required; featureId null unlinks the feature. */
export interface ReplaceJobInput {
  title: string;
  task: string;
  acceptanceCriteria: string[];
  featureId: string | null;
}

/** The updatable fields of a loaded job with the user's edits on top. */
export function jobReplacement(j: Job, edits: Partial<ReplaceJobInput> = {}): ReplaceJobInput {
  return overlay<ReplaceJobInput>(
    { title: j.title, task: j.task, acceptanceCriteria: j.acceptanceCriteria, featureId: j.featureId },
    edits,
  );
}

export interface CreateFeatureInput {
  title: string;
  spec?: string;
  acceptanceCriteria?: string[];
}

/** Mirrors ReplaceFeatureSchema: every key is required; an empty spec or list is a real value. */
export interface ReplaceFeatureInput {
  title: string;
  spec: string;
  acceptanceCriteria: string[];
}

/** The updatable fields of a loaded feature with the user's edits on top. */
export function featureReplacement(f: Feature, edits: Partial<ReplaceFeatureInput> = {}): ReplaceFeatureInput {
  return overlay<ReplaceFeatureInput>({ title: f.title, spec: f.spec, acceptanceCriteria: f.acceptanceCriteria }, edits);
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
export const LESSON_TARGET_KINDS = ['agents_md', 'repo_skill', 'routine_prompt', 'library_skill', 'other'] as const;
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
  /** The library skill the lesson is becoming or became (library_skill lessons). */
  appliedSkillName: string | null;
  appliedAt: string | null;
  sources: LessonSource[];
  /** Number of distinct jobs among the sources. */
  sourceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LessonPatternMember {
  lessonId: string;
  text: string;
  status: LessonStatus;
  sources: LessonSource[];
}

/** Mirrors LessonPatternSchema: a group of candidate/approved lessons that say the same thing. */
export interface LessonPattern {
  /** Hash of the member lesson ids. */
  id: string;
  representativeText: string;
  size: number;
  members: LessonPatternMember[];
  jobIds: string[];
  runIds: string[];
  repoIds: string[];
  firstSeen: string;
  lastSeen: string;
  /** Applied or applying lessons that already say (nearly) the same. */
  alreadyCovered: { lessonId: string; text: string; status: LessonStatus; appliedJobId: string | null; skillName: string | null }[];
}

/** Mirrors ProposeSkillSchema. */
export interface ProposeSkillInput {
  name: string;
  scope: 'global' | 'stack';
  stacks?: Stack[];
  title?: string;
}

export interface ProposeSkillResult {
  jobId: string;
  skillName: string;
  lessonIds: string[];
}

export interface LessonPatterns {
  method: 'embeddings' | 'text';
  threshold: number;
  patterns: LessonPattern[];
}

/** Mirrors ReplaceLessonSchema: every key is required; null clears the target and the note. */
export interface ReplaceLessonInput {
  text: string;
  targetKind: Exclude<LessonTargetKind, 'skill'> | null;
  targetRepoId: string | null;
  note: string | null;
}

/**
 * The editable fields of a loaded lesson with the user's edits on top. A legacy `skill` target kind cannot be sent back
 * (the API rejects it), so it is replaced by null unless the edits set another kind.
 */
export function lessonReplacement(l: Lesson, edits: Partial<ReplaceLessonInput> = {}): ReplaceLessonInput {
  return overlay<ReplaceLessonInput>(
    { text: l.text, targetKind: l.targetKind === 'skill' ? null : l.targetKind, targetRepoId: l.targetRepoId, note: l.note },
    edits,
  );
}

export type DispatchReason =
  | 'repo_paused' | 'project_paused' | 'no_manifest' | 'no_slots' | 'daily_limit' | 'budget' | 'none';

/** Why the estimated-spend guard stopped a repo: every hard day/week period of the project and global scope at once. */
export interface DispatchBudgetEvidence {
  blockers: BudgetBlocker[];
  /** reset: `resetsAt` is the latest blocker reset; manual: a limit or configuration change is needed; unknown: the evaluation failed. */
  recovery: 'reset' | 'manual' | 'unknown';
  /** True when the budget could not be evaluated; new automatic dispatch stays stopped. */
  error: boolean;
}

export interface RepoDispatchReport {
  repoId: string;
  fullName: string;
  queued: number;
  fired: number;
  reason: DispatchReason;
  detail: string | null;
  /** Next UTC midnight (ISO) when the reason is daily_limit; for budget the LATEST blocker reset, null without a reset promise. */
  resetsAt: string | null;
  waitingOnDependencies: number;
  waitingOnRevisions: number;
  /** Queued jobs whose owner has no executor that can take them right now. */
  waitingOnExecutor: number;
  /** Set when the reason is budget. */
  budget?: DispatchBudgetEvidence | null;
}

export interface DispatchStatus {
  at: string | null;
  result: { fired: number; failed: number; waitingOnExecutor: number; repos: RepoDispatchReport[] } | null;
}

const id = encodeURIComponent;

export const api = {
  me: () => request<CurrentUser>('/v1/auth/me'),
  listApiKeys: () => request<ApiKey[]>('/v1/api-keys'),
  createApiKey: (input: { name: string; expiresInDays?: number }) =>
    request<CreatedApiKey>('/v1/api-keys', 'POST', input),
  revokeApiKey: (keyId: string) => request<void>(`/v1/api-keys/${id(keyId)}`, 'DELETE'),
  listAgents: () => request<Agent[]>('/v1/agents'),
  getAgent: (agentId: string) => request<Agent>(`/v1/agents/${id(agentId)}`),
  listAgentBotUsers: () => request<AgentBotUser[]>('/v1/agents/bot-users'),
  replaceAgentSettings: (agentId: string, input: ReplaceAgentSettingsInput) =>
    request<Agent>(`/v1/agents/${id(agentId)}/settings`, 'PUT', input),
  listAgentAudit: (agentId: string) => request<AgentAuditEntry[]>(`/v1/agents/${id(agentId)}/audit`),
  getAgentTools: (agentId: string) => request<AgentTools>(`/v1/agents/${id(agentId)}/tools`),
  getSlackBot: () => request<SlackBot>('/v1/agents/slack'),
  /** The run log; callers treat a failure as "no runs" so the overview works without it. */
  listAgentRuns: (agentId: string, params?: AgentRunsParams) =>
    request<AgentRunPage>(`/v1/agents/${id(agentId)}/runs${agentRunsQuery(params)}`),
  getAgentRun: (runId: string) => request<AgentRunDetail>(`/v1/agent-runs/${id(runId)}`),
  getAgentPrompt: (agentId: string) => request<AgentPrompt>(`/v1/agents/${id(agentId)}/prompt`),
  listSlackDeliveries: (params: { page?: number; pageSize?: number } = {}) =>
    request<SlackDeliveryPage>(`/v1/agents/slack/notifications${agentRunsQuery(params)}`),
  listExecutors: () => request<Executor[]>('/v1/executors'),
  createExecutor: (input: CreateExecutorInput) => request<Executor>('/v1/executors', 'POST', input),
  replaceExecutor: (executorId: string, input: ReplaceExecutorInput) =>
    request<Executor>(`/v1/executors/${id(executorId)}`, 'PUT', input),
  replaceExecutorToken: (executorId: string, token: string) =>
    request<void>(`/v1/executors/${id(executorId)}/token`, 'PUT', { token }),
  resetExecutorExhaustion: (executorId: string) =>
    request<Executor>(`/v1/executors/${id(executorId)}/reset-exhaustion`, 'POST'),
  deleteExecutor: (executorId: string) => request<void>(`/v1/executors/${id(executorId)}`, 'DELETE'),
  listProjects: () => request<Project[]>('/v1/projects'),
  copilotStatus: () => request<CopilotStatus>('/v1/copilot/status'),
  listCopilotThreads: () => request<CopilotThread[]>('/v1/copilot/threads'),
  getCopilotThread: (threadId: string) => request<CopilotThreadMessages>(`/v1/copilot/threads/${id(threadId)}/messages`),
  scoutActivity: (projectId: string) => request<ScoutActivity>(`/v1/copilot/scout-activity?projectId=${id(projectId)}`),
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
  listLessonPatterns: (projectId: string, minSize?: number) =>
    request<LessonPatterns>(`/v1/projects/${id(projectId)}/lessons/patterns${minSize ? `?minSize=${minSize}` : ''}`),
  proposeSkillFromPattern: (projectId: string, patternId: string, input: ProposeSkillInput) =>
    request<ProposeSkillResult>(`/v1/projects/${id(projectId)}/lessons/patterns/${id(patternId)}/propose-skill`, 'POST', input),
  collectLessons: () => request<{ created: number }>('/v1/lessons/collect', 'POST'),
  replaceLesson: (lessonId: string, input: ReplaceLessonInput) =>
    request<Lesson>(`/v1/lessons/${id(lessonId)}`, 'PUT', input),
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
  /** Archived specs are hidden unless `archived` is true, which lists only those. */
  listSpecs: (projectId: string, archived?: boolean) =>
    request<Spec[]>(`/v1/projects/${id(projectId)}/specs${archived ? '?archived=true' : ''}`),
  listIntake: (projectId: string, status?: IntakeStatus, archived?: boolean) => {
    const query = [status && `status=${status}`, archived && 'archived=true'].filter(Boolean).join('&');
    return request<IntakeItem[]>(`/v1/projects/${id(projectId)}/intake${query ? `?${query}` : ''}`);
  },
  /** Verified humans only (403 otherwise). */
  getIntake: (itemId: string) => request<IntakeItemDetail>(`/v1/intake/${id(itemId)}`),
  retryIntake: (itemId: string) => request<IntakeItem>(`/v1/intake/${id(itemId)}/retry`, 'POST'),
  archiveIntake: (itemId: string) => request<IntakeItem>(`/v1/intake/${id(itemId)}/archive`, 'POST'),
  unarchiveIntake: (itemId: string) => request<IntakeItem>(`/v1/intake/${id(itemId)}/unarchive`, 'POST'),
  archiveSpec: (specId: string) => request<SpecDetail>(`/v1/specs/${id(specId)}/archive`, 'POST'),
  unarchiveSpec: (specId: string) => request<SpecDetail>(`/v1/specs/${id(specId)}/unarchive`, 'POST'),
  ignoreIntake: (itemId: string) => request<IntakeItem>(`/v1/intake/${id(itemId)}/ignore`, 'POST'),
  sweepIntake: () => request<IntakeSweepResult>('/v1/intake/sweep', 'POST'),
  getSpec: (specId: string) => request<SpecDetail>(`/v1/specs/${id(specId)}`),
  /** Verified humans only. Sends exactly the version the caller saw; a stale one is a 409. */
  approveSpec: (specId: string, expectedVersion: number) =>
    request<SpecDetail>(`/v1/specs/${id(specId)}/approve`, 'POST', { expectedVersion }),
  /** Verified humans only. Queues a planning run for the approved version: 403 for others, 409 when it cannot be queued. */
  planSpec: (specId: string) => request<SpecDetail>(`/v1/specs/${id(specId)}/plan`, 'POST'),
  getFeature: (featureId: string) => request<FeatureDetail>(`/v1/features/${id(featureId)}`),
  replaceFeature: (featureId: string, input: ReplaceFeatureInput) =>
    request<Feature>(`/v1/features/${id(featureId)}`, 'PUT', input),
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
  replaceJob: (jobId: string, input: ReplaceJobInput) => request<Job>(`/v1/jobs/${id(jobId)}`, 'PUT', input),
  enqueueJob: (jobId: string) => request<EnqueueResult>(`/v1/jobs/${id(jobId)}/enqueue`, 'POST'),
  triageJob: (jobId: string) => request<Job>(`/v1/jobs/${id(jobId)}/triage`, 'POST'),
  enqueueJobs: (ids: string[]) => request<EnqueueResult[]>('/v1/jobs/enqueue', 'POST', { ids }),
  cancelJob: (jobId: string) => request<Job>(`/v1/jobs/${id(jobId)}/cancel`, 'POST'),
  recreateJob: (jobId: string) => request<Job>(`/v1/jobs/${id(jobId)}/recreate`, 'POST'),
  retryJob: (jobId: string) => request<Job>(`/v1/jobs/${id(jobId)}/retry`, 'POST'),
  /** Re-checks the job's PR on GitHub (verified humans only). */
  syncJob: (jobId: string) => request<JobSyncResult>(`/v1/jobs/${id(jobId)}/sync`, 'POST'),
  /** The reconcile pass for one project's jobs (verified humans only). */
  reconcileProject: (projectId: string) => request<ReconcileResult>(`/v1/projects/${id(projectId)}/reconcile`, 'POST'),
  sendBackJob: (jobId: string, reason: string) => request<Job>(`/v1/jobs/${id(jobId)}/send-back`, 'POST', { reason }),
  /** Sends a conflicted PR back with the fixed merge instruction; uses no attempt. */
  fixConflicts: (jobId: string) => request<Job>(`/v1/jobs/${id(jobId)}/fix-conflicts`, 'POST'),
  setRepoPaused: (repoId: string, paused: boolean) =>
    request<Repo>(`/v1/repos/${id(repoId)}/${paused ? 'pause' : 'resume'}`, 'POST'),
  refreshRepoManifest: (repoId: string) => request<Repo>(`/v1/repos/${id(repoId)}/manifest/refresh`, 'POST'),
  createProject: (input: CreateProjectInput) => request<Project>('/v1/projects', 'POST', input),
  getBudget: (projectId?: string) => request<BudgetStatus>(`/v1/budget${projectId ? `?projectId=${id(projectId)}` : ''}`),
  listMcpServers: (projectId: string) => request<McpServer[]>(`/v1/projects/${id(projectId)}/mcp-servers`),
  getMcpServer: (projectId: string, serverId: string) =>
    request<McpServerDetail>(`/v1/projects/${id(projectId)}/mcp-servers/${id(serverId)}`),
  createMcpServer: (projectId: string, input: CreateMcpServerInput) =>
    request<McpServer>(`/v1/projects/${id(projectId)}/mcp-servers`, 'POST', input),
  replaceMcpServer: (projectId: string, serverId: string, input: ReplaceMcpServerInput) =>
    request<McpServer>(`/v1/projects/${id(projectId)}/mcp-servers/${id(serverId)}`, 'PUT', input),
  replaceMcpServerToken: (projectId: string, serverId: string, token: string) =>
    request<void>(`/v1/projects/${id(projectId)}/mcp-servers/${id(serverId)}/token`, 'PUT', { token }),
  testMcpServer: (projectId: string, serverId: string) =>
    request<McpTestResult>(`/v1/projects/${id(projectId)}/mcp-servers/${id(serverId)}/test`, 'POST'),
  replaceMcpServerTools: (projectId: string, serverId: string, tools: Pick<McpTool, 'name' | 'mode' | 'allowed'>[]) =>
    request<McpTool[]>(`/v1/projects/${id(projectId)}/mcp-servers/${id(serverId)}/tools`, 'PUT', { tools }),
  deleteMcpServer: (projectId: string, serverId: string) =>
    request<void>(`/v1/projects/${id(projectId)}/mcp-servers/${id(serverId)}`, 'DELETE'),
  getProject: (projectId: string) => request<Project>(`/v1/projects/${id(projectId)}`),
  createRepo: (projectId: string, input: CreateRepoInput) =>
    request<Repo>(`/v1/projects/${id(projectId)}/repos`, 'POST', input),
  getRepo: (repoId: string) => request<Repo>(`/v1/repos/${id(repoId)}`),
  replaceRepo: (repoId: string, input: ReplaceRepoInput) => request<Repo>(`/v1/repos/${id(repoId)}`, 'PUT', input),
  getRepoWorkspace: (repoId: string) => request<RepoWorkspace>(`/v1/repos/${id(repoId)}/workspace`),
  replaceProject: (projectId: string, input: ReplaceProjectInput) =>
    request<Project>(`/v1/projects/${id(projectId)}`, 'PUT', input),
  getSkillCatalog: (projectId: string) => request<SkillCatalog>(`/v1/projects/${id(projectId)}/skills`),
  refreshSkillCatalog: (projectId: string) => request<SkillCatalog>(`/v1/projects/${id(projectId)}/skills/refresh`, 'POST'),
  getSkillImpact: (projectId: string, days?: number) =>
    request<SkillImpact>(`/v1/projects/${id(projectId)}/skills/impact${days ? `?days=${days}` : ''}`),
  getRepoSkills: (repoId: string) => request<RepoSkills>(`/v1/repos/${id(repoId)}/skills`),
  promoteSkill: (repoId: string, name: string, input: PromoteSkillInput) =>
    request<PromoteSkillResult>(`/v1/repos/${id(repoId)}/skills/${id(name)}/promote`, 'POST', input),
  setProjectPaused: (projectId: string, paused: boolean) =>
    request<Project>(`/v1/projects/${id(projectId)}/${paused ? 'pause' : 'resume'}`, 'POST'),
};
