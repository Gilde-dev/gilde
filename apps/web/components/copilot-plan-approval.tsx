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

/** The plan carried by an approval interrupt for createPlannedFeature, or null for any other interrupt. */
export function planFromInterrupt(interrupt: ApprovalInterrupt | null | undefined): FeaturePlan | null {
  const m = interrupt?.metadata?.mastra;
  if (interrupt?.reason !== 'mastra:tool_approval' || m?.toolName !== PLAN_TOOL) return null;
  const a = m.args as Partial<FeaturePlan> | undefined;
  if (!a || !Array.isArray(a.jobs)) return null;
  return {
    projectId: a.projectId ?? '',
    title: a.title ?? '',
    spec: a.spec ?? '',
    acceptanceCriteria: a.acceptanceCriteria ?? [],
    jobs: a.jobs.map((j) => ({ ...j, acceptanceCriteria: j.acceptanceCriteria ?? [], dependsOn: j.dependsOn ?? [] })),
  };
}

/** The card with repo names resolved from the plan's project; shows ids until (or unless) the repos load. */
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
 * Renders the approval card in the chat when the agent wants to run createPlannedFeature. Approving resumes the
 * run with { approved: true }; cancelling declines the tool call, so nothing is created. Renders nothing itself.
 */
export function CopilotPlanApproval() {
  useInterrupt({
    agentId: 'gilde',
    enabled: (event) => planFromInterrupt(event.value as ApprovalInterrupt) !== null,
    render: ({ interrupt, resolve, cancel }) => {
      const plan = planFromInterrupt(interrupt as ApprovalInterrupt | null);
      if (!plan) return <></>;
      return <PlanApprovalWithRepos plan={plan} onApprove={() => resolve({ approved: true })} onCancel={() => cancel()} />;
    },
  });
  return null;
}
