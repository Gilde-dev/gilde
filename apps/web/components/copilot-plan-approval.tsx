'use client';

import { useInterrupt } from '@copilotkit/react-core/v2/headless';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

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
  title: string;
  spec: string;
  acceptanceCriteria: string[];
  jobs: PlanJob[];
}

export const PLAN_TOOL = 'createPlannedFeature';

/** The plan to approve, with Approve and Cancel. Jobs are collapsed; open one to see its full task. */
export function PlanApprovalCard({
  plan,
  repoNames = {},
  onApprove,
  onCancel,
}: {
  plan: FeaturePlan;
  repoNames?: Record<string, string>;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const titles = new Map(plan.jobs.map((j) => [j.key, j.title]));
  return (
    <section aria-label="Plan for approval" className="my-2 space-y-2 rounded-md border bg-background p-3 text-sm">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Create feature and jobs?</p>
        <h3 className="font-semibold">{plan.title}</h3>
        <p className="whitespace-pre-wrap text-muted-foreground">{plan.spec}</p>
      </header>
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
        <Button size="sm" onClick={onApprove}>
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
  return <PlanApprovalCard plan={plan} repoNames={repoNames} onApprove={onApprove} onCancel={onCancel} />;
}

/**
 * Renders the approval card in the chat when the agent wants to run createPlannedFeature or createJob (one
 * registration, dispatching on the tool name). Approving resumes the run with { approved: true }; cancelling
 * declines the tool call, so nothing is created. Renders nothing itself.
 */
export function CopilotPlanApproval() {
  useInterrupt({
    agentId: 'gilde',
    enabled: (event) => {
      const i = event.value as ApprovalInterrupt;
      return planFromInterrupt(i) !== null || jobFromInterrupt(i) !== null;
    },
    render: ({ interrupt, resolve, cancel }) => {
      const i = interrupt as ApprovalInterrupt | null;
      const approve = () => resolve({ approved: true });
      const plan = planFromInterrupt(i);
      if (plan) return <PlanApprovalWithRepos plan={plan} onApprove={approve} onCancel={() => cancel()} />;
      const job = jobFromInterrupt(i);
      if (job) return <JobApprovalWithNames job={job} onApprove={approve} onCancel={() => cancel()} />;
      return <></>;
    },
  });
  return null;
}
