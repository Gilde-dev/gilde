'use client';

import { Bot } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { limitTexts, startOfUtcDay, triggerText, type AgentRowId } from '@/lib/agent-labels';
import { api, type Agent, type AgentRunSummary, type SlackBot } from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { relativeTime } from '@/lib/time';
import { usePolling } from '@/lib/use-polling';
import { withProject } from '@/lib/use-project';
import { AgentStatusBadge } from './agent-status-badge';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';
import { PageHeader } from './ui/page-header';
import { Skeleton } from './ui/skeleton';

const POLL_MS = 30_000;

interface RunInfo {
  today: number;
  last: AgentRunSummary | null;
}

interface Overview {
  agents: Agent[];
  /** Null when the Slack bot could not be read; the other rows still show. */
  slack: SlackBot | null;
  /** Per agent; absent when the run log could not be read, which shows an empty cell instead of failing. */
  runs: Partial<Record<Agent['id'], RunInfo>>;
}

async function runInfo(id: Agent['id']): Promise<RunInfo | undefined> {
  try {
    const [today, last] = await Promise.all([
      api.listAgentRuns(id, { from: startOfUtcDay(), pageSize: 1 }),
      api.listAgentRuns(id, { pageSize: 1 }),
    ]);
    return { today: today.total, last: last.items[0] ?? null };
  } catch {
    return undefined;
  }
}

async function loadOverview(): Promise<Overview> {
  const [agents, slack] = await Promise.all([api.listAgents(), api.getSlackBot().catch(() => null)]);
  const infos = await Promise.all(agents.map((a) => runInfo(a.id)));
  const runs: Overview['runs'] = {};
  agents.forEach((a, i) => {
    const info = infos[i];
    if (info) runs[a.id] = info;
  });
  return { agents, slack, runs };
}

const OUTCOME_VARIANT = { ok: 'success', error: 'danger', refused: 'warning', skipped: 'neutral' } as const;

function LastRun({ run }: { run: AgentRunSummary | null | undefined }) {
  if (!run) return <span className="text-muted-foreground">No runs yet</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <time dateTime={run.startedAt} title={new Date(run.startedAt).toLocaleString()}>
        {relativeTime(run.startedAt)}
      </time>
      {run.outcome && <Badge variant={OUTCOME_VARIANT[run.outcome]}>{run.outcome}</Badge>}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-label text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function Row({
  id,
  label,
  status,
  reason,
  botUser,
  model,
  usage,
  limits,
  trigger,
  last,
  project,
}: {
  id: AgentRowId;
  label: string;
  status: React.ReactNode;
  reason: string | null;
  botUser: string | null;
  model: string | null;
  usage: React.ReactNode;
  limits: string[];
  trigger: string;
  last: React.ReactNode;
  project: string | null;
}) {
  return (
    <article aria-label={label} className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-md font-semibold">
          <Link href={withProject(`/agents/${id}`, project)} className="hover:underline">
            {label}
          </Link>
        </h2>
        {status}
      </div>
      {reason && <p className="text-sm text-muted-foreground">{reason}</p>}
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Bot user">{botUser ? <span className="font-mono">{botUser}</span> : <span className="text-muted-foreground">None</span>}</Fact>
        <Fact label="Model">{model ? <span className="font-mono">{model}</span> : <span className="text-muted-foreground">None</span>}</Fact>
        <Fact label="Trigger">{trigger}</Fact>
        <Fact label="Today">{usage}</Fact>
        <Fact label="Limits">
          {limits.length === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            <ul>
              {limits.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
        </Fact>
        <Fact label="Last run">{last}</Fact>
      </dl>
    </article>
  );
}

export function AgentsView() {
  const project = useSearchParams().get('project');
  const load = useCallback(loadOverview, []);
  const { data, error, loading, refresh } = usePolling(load, POLL_MS);

  return (
    <div className="space-y-4 p-4">
      <PageHeader title="Agents" description="Every agent and bot in Gilde: whether it is on, which account and model it uses, and what it has been doing." />
      {loading && !data && (
        <div role="status" aria-label="Loading agents" className="space-y-2">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      )}
      {error && !data && (
        <div role="alert" className="flex items-center gap-3 text-sm text-danger">
          <span>{errorText(error)}</span>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      )}
      {data && data.agents.length === 0 && <EmptyState icon={Bot} title="No agents" text="The API returned no agents." />}
      {data?.agents.map((a) => {
        const info = data.runs[a.id];
        return (
          <Row
            key={a.id}
            id={a.id}
            label={a.label}
            status={<AgentStatusBadge status={a.status} />}
            reason={a.reason}
            botUser={a.hasBotUser ? (a.botUser?.email ?? null) : null}
            model={a.effectiveModel}
            usage={info ? `${info.today} ${info.today === 1 ? 'run' : 'runs'} today` : <span className="text-muted-foreground">Not available</span>}
            limits={limitTexts(a)}
            trigger={triggerText(a.id, a)}
            last={info ? <LastRun run={info.last} /> : <span className="text-muted-foreground">Not available</span>}
            project={project}
          />
        );
      })}
      {data && (
        <Row
          id="slack"
          label="Slack bot"
          status={data.slack ? <AgentStatusBadge status={data.slack.status} /> : <Badge>Unknown</Badge>}
          reason={data.slack ? data.slack.reason : 'The Slack bot could not be read.'}
          botUser={data.slack?.botUsers[0]?.email ?? null}
          model={null}
          usage={<span className="text-muted-foreground">Not recorded</span>}
          limits={[]}
          trigger={triggerText('slack')}
          last={<span className="text-muted-foreground">Not recorded</span>}
          project={project}
        />
      )}
    </div>
  );
}
