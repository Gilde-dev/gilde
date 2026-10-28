'use client';

import { useInterrupt } from '@copilotkit/react-core/v2/headless';
import { useEffect, useState } from 'react';
import { api, type SpecDetail } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SafeMarkdown } from '@/components/safe-markdown';
import { TextDiffView } from '@/components/text-diff-view';

export interface PlanJob {
  key: string;
  repoId: string;
  title: string;
  task: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
}

/** The draft the co-pilot passes to createPlannedFeature. */
export interface FeaturePlan {
  projectId: string;
  /** Set when the plan is made from an approved spec version; the feature pins exactly this version. */
  specId?: string;
  specApproval?: { version: number; approvalId: string };
  title: string;
  spec: string;
  acceptanceCriteria: string[];
  jobs: PlanJob[];
}

export const PLAN_TOOL = 'createPlannedFeature';

/** Whether the spec a plan is pinned to is still at the approved version the plan was made from. */
export type PlanPin =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'stale'; message: string }
  | { state: 'current'; label: string };

/** How the pin of a plan looks against the spec as it is now. */
export function planPin(approval: { version: number; approvalId: string }, spec: SpecDetail): PlanPin {
  const label = `${spec.title} (${spec.slug}), approved version ${approval.version}`;
  if (spec.approvedVersion !== approval.version) {
    return { state: 'stale', message: `${spec.title} is now at approved version ${spec.approvedVersion ?? 'none'}, not ${approval.version}. Ask the co-pilot to plan again.` };
  }
  const v = spec.versions.find((x) => x.version === approval.version);
  if (v?.approval?.id !== approval.approvalId) {
    return { state: 'stale', message: `The approval this plan was made from is not the current approval of version ${approval.version}. Ask the co-pilot to plan again.` };
  }
  return { state: 'current', label };
}

/** The plan to approve, with Approve and Cancel. Jobs are collapsed; open one to see its full task. */
export function PlanApprovalCard({
  plan,
  repoNames = {},
  pin,
  onApprove,
  onCancel,
}: {
  plan: FeaturePlan;
  repoNames?: Record<string, string>;
  /** Required for a spec-linked plan: it cannot be approved until the pin is known to be current. */
  pin?: PlanPin;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const titles = new Map(plan.jobs.map((j) => [j.key, j.title]));
  const linked = plan.specId !== undefined;
  const canApprove = !linked || pin?.state === 'current';
  return (
    <section aria-label="Plan for approval" className="my-2 space-y-2 rounded-md border bg-background p-3 text-sm">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Create feature and jobs?</p>
        <h3 className="font-semibold">{plan.title}</h3>
        <p className="whitespace-pre-wrap text-muted-foreground">{plan.spec}</p>
      </header>
      {linked && (
        <div role={pin?.state === 'error' || pin?.state === 'stale' ? 'alert' : 'status'} className="rounded-md border bg-muted p-2 text-xs">
          {(!pin || pin.state === 'loading') && <p>Checking that the spec version is still the approved one…</p>}
          {pin?.state === 'current' && (
            <p>
              Pinned to <span className="font-medium">{pin.label}</span>. The feature keeps this version for good.
            </p>
          )}
          {pin?.state === 'stale' && <p className="text-danger">{pin.message}</p>}
          {pin?.state === 'error' && <p className="text-danger">Could not check the spec: {pin.message}</p>}
        </div>
      )}
      {plan.acceptanceCriteria.length > 0 && (
        <ul className="list-disc pl-5">
          {plan.acceptanceCriteria.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      <details>
        <summary className="cursor-pointer font-medium">
          {plan.jobs.length} {plan.jobs.length === 1 ? 'job' : 'jobs'}
        </summary>
        <ol className="mt-2 space-y-2">
          {plan.jobs.map((j) => (
            <li key={j.key} className="rounded border p-2">
              <p className="font-medium">{j.title}</p>
              <p className="text-xs text-muted-foreground">
                {repoNames[j.repoId] ?? j.repoId}
                {j.dependsOn.length > 0 && <> · after {j.dependsOn.map((k) => titles.get(k) ?? k).join(', ')}</>}
              </p>
              <details className="mt-1">
                <summary className="cursor-pointer text-xs font-medium">Task</summary>
                <p className="mt-1 whitespace-pre-wrap">{j.task}</p>
              </details>
              <ul className="mt-1 list-disc pl-5">
                {j.acceptanceCriteria.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </details>
      <p className="text-xs text-muted-foreground">Creates a draft feature and triage jobs. Nothing is started or queued.</p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={onApprove} disabled={!canApprove}>
          Approve
        </Button>
      </div>
    </section>
  );
}

interface ApprovalInterrupt {
  reason?: string;
  metadata?: { mastra?: { toolName?: string; args?: unknown } };
}

const isApproval = (interrupt: ApprovalInterrupt | null | undefined, tool: string) =>
  interrupt?.reason === 'mastra:tool_approval' && interrupt.metadata?.mastra?.toolName === tool;

/** The plan carried by an approval interrupt for createPlannedFeature, or null for any other interrupt. */
export function planFromInterrupt(interrupt: ApprovalInterrupt | null | undefined): FeaturePlan | null {
  if (!isApproval(interrupt, PLAN_TOOL)) return null;
  const a = interrupt?.metadata?.mastra?.args as Partial<FeaturePlan> | undefined;
  if (!a || !Array.isArray(a.jobs)) return null;
  return {
    projectId: a.projectId ?? '',
    ...(a.specId ? { specId: a.specId, specApproval: a.specApproval } : {}),
    title: a.title ?? '',
    spec: a.spec ?? '',
    acceptanceCriteria: a.acceptanceCriteria ?? [],
    jobs: a.jobs.map((j) => ({ ...j, acceptanceCriteria: j.acceptanceCriteria ?? [], dependsOn: j.dependsOn ?? [] })),
  };
}

/** The job the co-pilot passes to createJob. */
export interface JobDraft {
  repoId: string;
  title: string;
  task: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  featureId?: string;
}

export const JOB_TOOL = 'createJob';

/** The job carried by an approval interrupt for createJob, or null for any other interrupt. */
export function jobFromInterrupt(interrupt: ApprovalInterrupt | null | undefined): JobDraft | null {
  if (!isApproval(interrupt, JOB_TOOL)) return null;
  const a = interrupt?.metadata?.mastra?.args as Partial<JobDraft> | undefined;
  if (!a || typeof a.title !== 'string' || typeof a.task !== 'string') return null;
  return {
    repoId: a.repoId ?? '',
    title: a.title,
    task: a.task,
    acceptanceCriteria: a.acceptanceCriteria ?? [],
    dependsOn: a.dependsOn ?? [],
    featureId: a.featureId,
  };
}

/** The job to approve, with Approve and Cancel. A long task is collapsed; open it to read the rest. */
export function JobApprovalCard({
  job,
  repoName,
  featureTitle,
  dependencyTitles = {},
  onApprove,
  onCancel,
}: {
  job: JobDraft;
  repoName?: string;
  featureTitle?: string;
  dependencyTitles?: Record<string, string>;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const long = job.task.length > 280 || job.task.split('\n').length > 6;
  return (
    <section aria-label="Job for approval" className="my-2 space-y-2 rounded-md border bg-background p-3 text-sm">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Create job?</p>
        <h3 className="font-semibold">{job.title}</h3>
        <p className="font-mono text-xs text-muted-foreground">
          {repoName ?? job.repoId}
          {job.featureId && <> · feature {featureTitle ?? job.featureId}</>}
        </p>
      </header>
      {long ? (
        <details>
          <summary className="cursor-pointer font-medium">Task</summary>
          <p className="mt-1 whitespace-pre-wrap">{job.task}</p>
        </details>
      ) : (
        <p className="whitespace-pre-wrap">{job.task}</p>
      )}
      {job.acceptanceCriteria.length > 0 && (
        <ul className="list-disc pl-5">
          {job.acceptanceCriteria.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      {job.dependsOn.length > 0 && <p className="text-xs text-muted-foreground">After {job.dependsOn.map((d) => dependencyTitles[d] ?? d).join(', ')}</p>}
      <p className="text-xs text-muted-foreground">Creates one job in triage. Nothing is started or queued.</p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={onApprove}>
          Approve
        </Button>
      </div>
    </section>
  );
}

/** The card with repo, feature and dependency names looked up; shows ids until (or unless) they load. */
function JobApprovalWithNames({ job, onApprove, onCancel }: { job: JobDraft; onApprove: () => void; onCancel: () => void }) {
  const [repoName, setRepoName] = useState<string>();
  const [featureTitle, setFeatureTitle] = useState<string>();
  const [dependencyTitles, setDependencyTitles] = useState<Record<string, string>>({});
  const depKey = job.dependsOn.join(',');
  useEffect(() => {
    let cancelled = false;
    const when = <T,>(p: Promise<T>, set: (v: T) => void) => p.then((v) => !cancelled && set(v)).catch(() => {});
    when(api.getRepo(job.repoId), (r) => setRepoName(r.fullName));
    if (job.featureId) when(api.getFeature(job.featureId), (f) => setFeatureTitle(f.title));
    for (const id of job.dependsOn) when(api.getJob(id), (j) => setDependencyTitles((t) => ({ ...t, [id]: j.title })));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.repoId, job.featureId, depKey]);
  return <JobApprovalCard job={job} repoName={repoName} featureTitle={featureTitle} dependencyTitles={dependencyTitles} onApprove={onApprove} onCancel={onCancel} />;
}

/** The plan card with repo names resolved from the plan's project; shows ids until (or unless) the repos load. */
function PlanApprovalWithRepos({ plan, onApprove, onCancel }: { plan: FeaturePlan; onApprove: () => void; onCancel: () => void }) {
  const [repoNames, setRepoNames] = useState<Record<string, string>>({});
  const [pin, setPin] = useState<PlanPin>({ state: 'loading' });
  const { specId, specApproval } = plan;
  useEffect(() => {
    if (!specId) return;
    if (!specApproval) {
      setPin({ state: 'error', message: 'The plan names a spec but not the approved version.' });
      return;
    }
    let cancelled = false;
    setPin({ state: 'loading' });
    api
      .getSpec(specId)
      .then((spec) => !cancelled && setPin(planPin(specApproval, spec)))
      .catch((e) => !cancelled && setPin({ state: 'error', message: e instanceof Error ? e.message : 'unknown error' }));
    return () => {
      cancelled = true;
    };
  }, [specId, specApproval?.version, specApproval?.approvalId]);
  useEffect(() => {
    if (!plan.projectId) return;
    let cancelled = false;
    api
      .listRepos(plan.projectId)
      .then((repos) => !cancelled && setRepoNames(Object.fromEntries(repos.map((r) => [r.id, r.fullName]))))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [plan.projectId]);
  return <PlanApprovalCard plan={plan} repoNames={repoNames} pin={plan.specId ? pin : undefined} onApprove={onApprove} onCancel={onCancel} />;
}

/** The spec the co-pilot passes to draftSpec. */
export interface SpecDraft {
  specId?: string;
  projectId?: string;
  repoId?: string;
  slug?: string;
  title: string;
  body: string;
  /** 0 for a new spec, otherwise the version the draft was written against. */
  expectedVersion: number;
}

export const SPEC_TOOL = 'draftSpec';

/** The draft carried by an approval interrupt for draftSpec, or null for any other interrupt. */
export function specDraftFromInterrupt(interrupt: ApprovalInterrupt | null | undefined): SpecDraft | null {
  if (!isApproval(interrupt, SPEC_TOOL)) return null;
  const a = interrupt?.metadata?.mastra?.args as Partial<SpecDraft> | undefined;
  if (!a || typeof a.title !== 'string' || typeof a.body !== 'string' || typeof a.expectedVersion !== 'number') return null;
  return { specId: a.specId, projectId: a.projectId, repoId: a.repoId, slug: a.slug, title: a.title, body: a.body, expectedVersion: a.expectedVersion };
}

/** What a draft is compared with. Only `ready` may be saved; every other state fails closed. */
export type SpecPreview =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'stale'; message: string }
  | { state: 'ready'; previous: { version: number; title: string; body: string } | null };

/** The preview of a draft against the spec as it is now (null for a new spec, which has nothing to compare with). */
export function specPreview(draft: SpecDraft, spec: SpecDetail | null): SpecPreview {
  if (!draft.specId) {
    if (draft.expectedVersion !== 0) return { state: 'error', message: 'A new spec must be saved at version 0.' };
    if (!draft.projectId || !draft.repoId || !draft.slug) return { state: 'error', message: 'A new spec needs a project, a repo and a slug.' };
    return { state: 'ready', previous: null };
  }
  if (!spec) return { state: 'loading' };
  if (draft.expectedVersion < 1) return { state: 'error', message: 'A new version of an existing spec needs the version it was written against.' };
  if (spec.currentVersion !== draft.expectedVersion) {
    return { state: 'stale', message: `The spec is now at version ${spec.currentVersion}; this draft was written against version ${draft.expectedVersion}. Cancel and ask the co-pilot to redo it.` };
  }
  const previous = spec.versions.find((v) => v.version === draft.expectedVersion);
  if (!previous) return { state: 'error', message: `Version ${draft.expectedVersion} of the spec was not returned.` };
  return { state: 'ready', previous: { version: previous.version, title: previous.title, body: previous.body } };
}

/**
 * The spec draft to save, with Cancel and Save draft. It looks different from the approval cards on purpose: saving stores a
 * draft version and nothing else; approving a spec is not possible here. Save draft stays disabled until the comparison with
 * the current version has loaded and the draft is not stale.
 */
export function SpecDraftCard({
  draft,
  preview,
  repoName,
  onSave,
  onCancel,
}: {
  draft: SpecDraft;
  preview: SpecPreview;
  repoName?: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  const isNew = !draft.specId;
  return (
    <section aria-label="Spec draft to save" className="my-2 space-y-2 rounded-md border border-dashed bg-background p-3 text-sm">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{isNew ? 'Save new spec as draft?' : `Save version ${draft.expectedVersion + 1} as draft?`}</p>
          <Badge variant="warning">Draft · not approved</Badge>
        </div>
        <h3 className="font-semibold">{draft.title}</h3>
        {isNew && (
          <p className="font-mono text-xs text-muted-foreground">
            {draft.slug} · {repoName ?? draft.repoId}
          </p>
        )}
        {preview.state === 'ready' && preview.previous && preview.previous.title !== draft.title && (
          <p className="text-xs text-muted-foreground">Title was “{preview.previous.title}”.</p>
        )}
      </header>

      {preview.state === 'loading' && <p role="status" className="text-xs text-muted-foreground">Loading the current version to compare…</p>}
      {preview.state === 'error' && (
        <p role="alert" className="text-xs text-danger">
          Cannot save this draft: {preview.message}
        </p>
      )}
      {preview.state === 'stale' && (
        <p role="alert" className="text-xs text-danger">
          {preview.message}
        </p>
      )}
      {preview.state === 'ready' && preview.previous && (
        <div className="space-y-1">
          <p className="text-xs font-medium">Changes against version {preview.previous.version}</p>
          <TextDiffView before={preview.previous.body} after={draft.body} />
        </div>
      )}
      <details>
        <summary className="cursor-pointer font-medium">Proposed spec</summary>
        <SafeMarkdown source={draft.body} className="mt-1" />
      </details>

      <p className="text-xs text-muted-foreground">Saves a draft version only. It does not approve the spec: a verified human approves it in Gilde.</p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="secondary" size="sm" onClick={onSave} disabled={preview.state !== 'ready'}>
          Save draft
        </Button>
      </div>
    </section>
  );
}

/** The spec card with the current version and the repo name loaded; saving stays off until the comparison is in. */
function SpecDraftWithPreview({ draft, onSave, onCancel }: { draft: SpecDraft; onSave: () => void; onCancel: () => void }) {
  const [spec, setSpec] = useState<SpecDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repoName, setRepoName] = useState<string>();
  const { specId, repoId } = draft;
  useEffect(() => {
    let cancelled = false;
    setSpec(null);
    setError(null);
    if (specId) {
      api
        .getSpec(specId)
        .then((v) => !cancelled && setSpec(v))
        .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'unknown error'));
    }
    if (repoId) {
      api
        .getRepo(repoId)
        .then((r) => !cancelled && setRepoName(r.fullName))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [specId, repoId]);
  const preview: SpecPreview = error ? { state: 'error', message: error } : specPreview(draft, spec);
  return <SpecDraftCard draft={draft} preview={preview} repoName={repoName} onSave={onSave} onCancel={onCancel} />;
}

/**
 * Renders the approval card in the chat when the agent wants to run createPlannedFeature, createJob or draftSpec (one
 * registration, dispatching on the tool name; draftSpec gets the Save draft card, never an Approve one). Approving resumes the run with { approved: true }; cancelling
 * declines the tool call, so nothing is created. Renders nothing itself.
 */
export function CopilotPlanApproval() {
  useInterrupt({
    agentId: 'gilde',
    enabled: (event) => {
      const i = event.value as ApprovalInterrupt;
      return planFromInterrupt(i) !== null || jobFromInterrupt(i) !== null || specDraftFromInterrupt(i) !== null;
    },
    render: ({ interrupt, resolve, cancel }) => {
      const i = interrupt as ApprovalInterrupt | null;
      const approve = () => resolve({ approved: true });
      const plan = planFromInterrupt(i);
      if (plan) return <PlanApprovalWithRepos plan={plan} onApprove={approve} onCancel={() => cancel()} />;
      const job = jobFromInterrupt(i);
      if (job) return <JobApprovalWithNames job={job} onApprove={approve} onCancel={() => cancel()} />;
      const specDraft = specDraftFromInterrupt(i);
      if (specDraft) return <SpecDraftWithPreview draft={specDraft} onSave={approve} onCancel={() => cancel()} />;
      return <></>;
    },
  });
  return null;
}
