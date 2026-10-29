'use client';

import Link from 'next/link';
import { Fragment, useCallback, useState } from 'react';
import {
  AGENT_RUN_OUTCOMES,
  AGENT_RUN_TRIGGERS,
  api,
  type AgentRunOutcome,
  type AgentRunSummary,
  type AgentRunTrigger,
  type SlackDelivery,
} from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { relativeTime } from '@/lib/time';
import { usePolling } from '@/lib/use-polling';
import { withProject } from '@/lib/use-project';
import { Badge, type BadgeVariant } from './ui/badge';
import { Button } from './ui/button';
import { Select } from './ui/select';
import { Skeleton } from './ui/skeleton';

const POLL_MS = 30_000;
const PAGE_SIZE = 25;
const MAX_SHOWN = 4000;

const TRIGGER_LABEL: Record<AgentRunTrigger, string> = {
  chat: 'Chat',
  signal: 'Signal',
  schedule: 'Schedule',
  intake_item: 'Intake item',
  spec_version: 'Spec version',
  dispatch: 'Dispatch',
  mcp_call: 'MCP call',
};
const OUTCOME: Record<AgentRunOutcome | 'running', { label: string; variant: BadgeVariant }> = {
  ok: { label: 'OK', variant: 'success' },
  error: { label: 'Error', variant: 'danger' },
  refused: { label: 'Refused', variant: 'warning' },
  skipped: { label: 'Skipped', variant: 'neutral' },
  running: { label: 'Running', variant: 'running' },
};
const PERIODS = [
  { key: 'all', label: 'All time', ms: 0 },
  { key: '1d', label: 'Last 24 hours', ms: 24 * 3600_000 },
  { key: '7d', label: 'Last 7 days', ms: 7 * 24 * 3600_000 },
  { key: '30d', label: 'Last 30 days', ms: 30 * 24 * 3600_000 },
] as const;

function OutcomeBadge({ outcome }: { outcome: AgentRunSummary['outcome'] }) {
  const { label, variant } = OUTCOME[outcome ?? 'running'];
  return (
    <Badge variant={variant} dot>
      {label}
    </Badge>
  );
}

/** The run's trigger as a link where Gilde has a page for it; plain text otherwise (and nothing for another user's chat). */
function TriggerCell({ run, project }: { run: AgentRunSummary; project: string | null }) {
  const label = TRIGGER_LABEL[run.triggerKind];
  const id = run.triggerRefId;
  const target =
    run.metadataOnly || !id
      ? null
      : run.triggerRefType === 'job'
        ? { href: `/jobs/${id}`, text: 'job' }
        : run.triggerRefType === 'spec'
          ? { href: `/specs/${id}`, text: 'spec' }
          : run.triggerRefType === 'intake_item'
            ? { href: '/intake', text: 'intake item' }
            : run.triggerRefType === 'thread'
              ? { href: '/chat', text: 'chat' }
              : null;
  return (
    <>
      <span>{label}</span>
      {target && (
        <>
          {' · '}
          <Link href={withProject(target.href, project)} className="underline">
            {target.text}
          </Link>
        </>
      )}
    </>
  );
}

function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav aria-label="Pagination" className="flex items-center gap-3 text-sm">
      <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <span>
        Page {page} of {pages} · {total} {total === 1 ? 'run' : 'runs'}
      </span>
      <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </nav>
  );
}

/** Capped, escaped plain text: recorded content is data and never markup. */
function Text({ label, value }: { label: string; value: string | null }) {
  if (value === null || value === '') return null;
  const shown = value.length > MAX_SHOWN ? `${value.slice(0, MAX_SHOWN)}… (cut at ${MAX_SHOWN} characters)` : value;
  return (
    <div>
      <p className="text-label text-muted-foreground">{label}</p>
      <pre tabIndex={0} className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-2 font-mono text-sm">
        {shown}
      </pre>
    </div>
  );
}

function ToolCalls({ runId }: { runId: string }) {
  const load = useCallback(() => api.getAgentRun(runId), [runId]);
  const { data, error, loading } = usePolling(load, 60_000);
  if (loading && !data) return <Skeleton className="h-12" />;
  if (error && !data) return <p role="alert" className="text-sm text-danger">{errorText(error)}</p>;
  if (!data) return null;
  return (
    <div className="space-y-3">
      <Text label="Reason" value={data.reason} />
      {data.toolCalls.length === 0 && <p className="text-sm text-muted-foreground">No tool calls were recorded.</p>}
      <ol aria-label="Tool calls" className="space-y-3">
        {data.toolCalls.map((t) => (
          <li key={t.id} className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm">{t.toolName}</span>
              <span className="text-sm text-muted-foreground">{t.durationMs === null ? 'duration unknown' : `${t.durationMs} ms`}</span>
              {t.error !== null && <Badge variant="danger">Error</Badge>}
            </div>
            <Text label="Error" value={t.error} />
            <Text label="Input" value={t.input} />
            <Text label="Output" value={t.output} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function RunRow({ run, coding, projectName, project }: { run: AgentRunSummary; coding: boolean; projectName: string; project: string | null }) {
  const [open, setOpen] = useState(false);
  const cols = coding ? 8 : 7;
  return (
    <Fragment>
      <tr className="border-t border-border-subtle align-top">
        <td className="px-3 py-2">
          <time dateTime={run.startedAt} title={new Date(run.startedAt).toLocaleString()}>
            {relativeTime(run.startedAt)}
          </time>
        </td>
        <td className="px-3 py-2">
          <TriggerCell run={run} project={project} />
        </td>
        <td className="px-3 py-2">
          <OutcomeBadge outcome={run.outcome} />
        </td>
        <td className="px-3 py-2">{projectName}</td>
        {coding && <td className="px-3 py-2">{run.executor?.name ?? '—'}</td>}
        <td className="px-3 py-2 font-mono">{run.model ?? '—'}</td>
        <td className="px-3 py-2">{run.toolCallCount}</td>
        <td className="px-3 py-2">
          {run.metadataOnly ? (
            <Badge variant="neutral">Metadata only</Badge>
          ) : (
            <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? 'Hide' : 'Details'}
              <span className="sr-only"> of the run {relativeTime(run.startedAt)}</span>
            </Button>
          )}
        </td>
      </tr>
      {open && !run.metadataOnly && (
        <tr>
          <td colSpan={cols} className="bg-muted/40 px-3 py-3">
            <ToolCalls runId={run.id} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function RunsTable({ agent, project }: { agent: string; project: string | null }) {
  const coding = agent === 'coding';
  const [trigger, setTrigger] = useState<AgentRunTrigger | ''>('');
  const [outcome, setOutcome] = useState<AgentRunOutcome | ''>('');
  const [projectId, setProjectId] = useState('');
  const [executorId, setExecutorId] = useState('');
  const [period, setPeriod] = useState<(typeof PERIODS)[number]['key']>('all');
  const [page, setPage] = useState(1);
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  const projects = usePolling(api.listProjects, 5 * 60_000);
  const loadExecutors = useCallback(() => (coding ? api.listExecutors() : Promise.resolve([])), [coding]);
  const executors = usePolling(loadExecutors, 5 * 60_000);
  const load = useCallback(() => {
    const ms = PERIODS.find((p) => p.key === period)?.ms ?? 0;
    return api.listAgentRuns(agent, {
      trigger: trigger || undefined,
      outcome: outcome || undefined,
      projectId: projectId || undefined,
      executorId: executorId || undefined,
      from: ms ? new Date(Date.now() - ms).toISOString() : undefined,
      page,
      pageSize: PAGE_SIZE,
    });
  }, [agent, trigger, outcome, projectId, executorId, period, page]);
  const { data, error, loading, refresh } = usePolling(load, POLL_MS);
  const names = new Map((projects.data ?? []).map((p) => [p.id, p.name]));

  return (
    <div className="space-y-4">
      <form aria-label="Filters" className="flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()}>
        <label className="space-y-1 text-label">
          Trigger
          <Select value={trigger} onChange={(e) => reset(setTrigger)(e.target.value as AgentRunTrigger | '')}>
            <option value="">All triggers</option>
            {AGENT_RUN_TRIGGERS.map((t) => (
              <option key={t} value={t}>
                {TRIGGER_LABEL[t]}
              </option>
            ))}
          </Select>
        </label>
        <label className="space-y-1 text-label">
          Outcome
          <Select value={outcome} onChange={(e) => reset(setOutcome)(e.target.value as AgentRunOutcome | '')}>
            <option value="">All outcomes</option>
            {AGENT_RUN_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {OUTCOME[o].label}
              </option>
            ))}
          </Select>
        </label>
        <label className="space-y-1 text-label">
          Project
          <Select value={projectId} onChange={(e) => reset(setProjectId)(e.target.value)}>
            <option value="">All projects</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        {coding && (
          <label className="space-y-1 text-label">
            Executor
            <Select value={executorId} onChange={(e) => reset(setExecutorId)(e.target.value)}>
              <option value="">All executors</option>
              {(executors.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        <label className="space-y-1 text-label">
          Period
          <Select value={period} onChange={(e) => reset(setPeriod)(e.target.value as typeof period)}>
            {PERIODS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </Select>
        </label>
      </form>
      {loading && !data && (
        <div role="status" aria-label="Loading runs" className="space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
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
      {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">No runs match.</p>}
      {data && data.items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="text-label text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Trigger</th>
                <th className="px-3 py-2">Outcome</th>
                <th className="px-3 py-2">Project</th>
                {coding && <th className="px-3 py-2">Executor</th>}
                <th className="px-3 py-2">Model</th>
                <th className="px-3 py-2">Tool calls</th>
                <th className="px-3 py-2">
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <RunRow key={r.id} run={r} coding={coding} project={project} projectName={(r.projectId && names.get(r.projectId)) || '—'} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > 0 && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
    </div>
  );
}

function SlackDeliveries() {
  const [page, setPage] = useState(1);
  const load = useCallback(() => api.listSlackDeliveries({ page, pageSize: PAGE_SIZE }), [page]);
  const { data, error, loading, refresh } = usePolling(load, POLL_MS);
  return (
    <div className="space-y-4">
      <p className="max-w-prose text-sm text-muted-foreground">
        The Slack bot does not log its chat answers separately: those are co-pilot runs. Below are the notifications from the outbox that it
        delivered or failed to deliver.
      </p>
      {loading && !data && <Skeleton className="h-10" />}
      {error && !data && (
        <div role="alert" className="flex items-center gap-3 text-sm text-danger">
          <span>{errorText(error)}</span>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      )}
      {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">Nothing was delivered yet.</p>}
      {data && data.items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="text-label text-muted-foreground">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((d: SlackDelivery) => (
                <tr key={d.id} className="border-t border-border-subtle align-top">
                  <td className="px-3 py-2">
                    <time dateTime={d.deliveredAt ?? d.occurredAt}>{relativeTime(d.deliveredAt ?? d.occurredAt)}</time>
                  </td>
                  <td className="px-3 py-2 font-mono">{d.kind}</td>
                  <td className="px-3 py-2">{d.title}</td>
                  <td className="px-3 py-2">
                    <Badge variant={d.status === 'delivered' ? 'success' : 'danger'} dot>
                      {d.status === 'delivered' ? 'Delivered' : 'Failed'}
                    </Badge>
                    {d.lastError && <p className="mt-1 text-sm text-muted-foreground">{d.lastError}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > 0 && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
    </div>
  );
}

export function ActivityTab({ agent, project }: { agent: string; project: string | null }) {
  return agent === 'slack' ? <SlackDeliveries /> : <RunsTable agent={agent} project={project} />;
}
