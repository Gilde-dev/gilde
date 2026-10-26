'use client';

import { useCallback, useState } from 'react';
import { api, type AgentUsage, type AgentTotals, type Usage, type UsageTotals } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { AgentTokenCategories, ESTIMATE_NOTE, formatEstimatedCost, formatTokens, tokenShare } from './agent-usage';
import { Button } from './ui/button';

const POLL_MS = 60_000;

export { formatTokens };
/** A dash when the cost is unknown (no price in LLM_PRICES). */
export const formatCost = (usd: number | null) => (usd === null ? '–' : `$${usd.toFixed(usd < 1 ? 4 : 2)}`);

/** Co-pilot usage (always all projects) next to Claude Code agent usage (selected project or all). */
export function UsageSection({ days, projectId, projectName }: { days: number; projectId?: string | null; projectName?: string }) {
  return (
    <>
      <CopilotUsage days={days} />
      <AgentUsageSection days={days} projectId={projectId ?? null} projectName={projectName} />
    </>
  );
}

function CopilotUsage({ days }: { days: number }) {
  const fetchUsage = useCallback(() => api.getUsage(days), [days]);
  const usage = usePolling(fetchUsage, POLL_MS);
  return (
    <section aria-label="Usage" className="space-y-4 border-t border-border p-4">
      <h2 className="font-serif text-lg font-semibold">Co-pilot usage</h2>
      <p className="text-sm text-muted-foreground">Co-pilot (chat and embeddings) across all projects; not filtered by the selected project.</p>
      {usage.error && <p className="text-sm text-danger">{usage.error.message}</p>}
      {usage.loading && !usage.data && <p className="text-sm text-muted-foreground">Loading…</p>}
      {usage.data && <UsageBody usage={usage.data} />}
    </section>
  );
}

export function UsageBody({ usage }: { usage: Usage }) {
  if (usage.totals.runs === 0) {
    return <p className="text-sm text-muted-foreground">No LLM usage in the last {usage.days} days.</p>;
  }
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Total tokens" value={formatTokens(usage.totals.totalTokens)} />
        <Tile label="Cost" value={formatCost(usage.totals.costUsd)} />
        <Tile label="Input / cached" value={`${formatTokens(usage.totals.inputTokens)} / ${formatTokens(usage.totals.cachedInputTokens)}`} />
        <Tile label="Output" value={formatTokens(usage.totals.outputTokens)} />
      </div>
      <UsageChart daily={usage.daily} />
      <div className="grid gap-6 md:grid-cols-2">
        <UsageTable title="Per model" rows={usage.byModel.map((r) => ({ key: r.model, name: r.model, totals: r }))} />
        <UsageTable title="Per user" rows={usage.byUser.map((r) => ({ key: r.userId ?? 'none', name: r.userName ?? (r.userId ? 'Unknown user' : 'System'), totals: r }))} />
      </div>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

const W = 600;
const H = 140;

function UsageChart({ daily }: { daily: Usage['daily'] }) {
  const max = Math.max(1, ...daily.map((d) => d.totalTokens));
  const slot = W / Math.max(1, daily.length);
  return (
    <figure aria-label="Daily token usage">
      <figcaption className="mb-2 text-sm font-semibold">Tokens per day</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" role="img" aria-label="Tokens used per day" preserveAspectRatio="none">
        {daily.map((d, i) => {
          const h = (d.totalTokens / max) * H;
          return (
            <rect key={d.date} x={i * slot + slot * 0.1} y={H - h} width={slot * 0.8} height={h} className="fill-info">
              <title>{`${d.date}: ${formatTokens(d.totalTokens)} tokens, ${formatCost(d.costUsd)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{daily[0]?.date}</span>
        <span>{daily[daily.length - 1]?.date}</span>
      </div>
    </figure>
  );
}

function UsageTable({ title, rows }: { title: string; rows: { key: string; name: string; totals: UsageTotals }[] }) {
  return (
    <section aria-label={title}>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="py-1 font-normal">Name</th>
            <th className="py-1 font-normal">Runs</th>
            <th className="py-1 font-normal">Tokens</th>
            <th className="py-1 font-normal">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-border">
              <td className="py-1">{r.name}</td>
              <td className="py-1">{r.totals.runs}</td>
              <td className="py-1">{formatTokens(r.totals.totalTokens)}</td>
              <td className="py-1">{formatCost(r.totals.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Claude Code routine usage over the last `days` UTC days. Scope is explicit: the selected project, or everything including unattributed. */
export function AgentUsageSection({ days, projectId, projectName }: { days: number; projectId: string | null; projectName?: string }) {
  const [all, setAll] = useState(false);
  const scoped = projectId && !all ? projectId : undefined;
  const fetchUsage = useCallback(() => api.getAgentUsage(days, scoped), [days, scoped]);
  const usage = usePolling(fetchUsage, POLL_MS);
  return (
    <section aria-label="Agents (Claude Code)" className="space-y-4 border-t border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-serif text-lg font-semibold">Agents (Claude Code)</h2>
        {projectId && (
          <div role="group" aria-label="Agent usage scope" className="ml-auto flex gap-1">
            <Button size="sm" variant={all ? 'outline' : 'primary'} aria-pressed={!all} onClick={() => setAll(false)}>
              {projectName ?? 'Selected project'}
            </Button>
            <Button size="sm" variant={all ? 'primary' : 'outline'} aria-pressed={all} onClick={() => setAll(true)}>
              All projects + unattributed
            </Button>
          </div>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {scoped
          ? `Usage of runs in ${projectName ?? 'the selected project'}, last ${days} UTC days. Usage not yet matched to a run has no known project and is not included; switch to all projects to see it.`
          : `All projects including usage not matched to a run, last ${days} UTC days.`}{' '}
        {ESTIMATE_NOTE}
      </p>
      {usage.error && <p className="text-sm text-danger">{usage.error.message}</p>}
      {usage.loading && !usage.data && <p className="text-sm text-muted-foreground">Loading…</p>}
      {usage.data && <AgentUsageBody usage={usage.data} />}
    </section>
  );
}

export function AgentUsageBody({ usage }: { usage: AgentUsage }) {
  const t = usage.totals;
  if (t.runs === 0 && usage.unattributed.runs === 0) {
    return <p className="text-sm text-muted-foreground">No Claude Code telemetry received in the last {usage.days} days.</p>;
  }
  const global = usage.scope === 'global';
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Total tokens" value={formatTokens(t.totalTokens)} />
        <Tile label="Estimated cost (USD)" value={formatEstimatedCost(t)} />
        <Tile label="Requests" value={String(t.runs)} />
        <Tile
          label="Unattributed share of tokens"
          value={global ? tokenShare(usage.unattributed.totalTokens, t.totalTokens) : 'n/a'}
          hint={global ? `${formatTokens(usage.unattributed.totalTokens)} of ${formatTokens(t.totalTokens)} tokens` : 'Only in the all-projects view'}
        />
      </div>
      <AgentTokenCategories t={t} />
      <AgentChart daily={usage.daily} />
      <div className="grid gap-6 md:grid-cols-3">
        <AgentTable title="Per model" rows={usage.byModel.map((r) => ({ key: r.model, name: r.model, totals: r }))} />
        <AgentTable title="Per repo" rows={usage.byRepo.map((r) => ({ key: r.repoId, name: r.fullName ?? r.repoId, totals: r }))} />
        <AgentTable title="Per feature" rows={usage.byFeature.map((r) => ({ key: r.featureId, name: r.title ?? r.featureId, totals: r }))} />
      </div>
    </div>
  );
}

function AgentChart({ daily }: { daily: AgentUsage['daily'] }) {
  const max = Math.max(1, ...daily.map((d) => d.totalTokens));
  const slot = W / Math.max(1, daily.length);
  return (
    <figure aria-label="Daily agent token usage">
      <figcaption className="mb-2 text-sm font-semibold">Agent tokens per day (UTC), estimated cost in tooltips</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" role="img" aria-label="Agent tokens used per day, with estimated cost" preserveAspectRatio="none">
        {daily.map((d, i) => {
          const h = (d.totalTokens / max) * H;
          return (
            <rect key={d.date} x={i * slot + slot * 0.1} y={H - h} width={slot * 0.8} height={h} className="fill-running">
              <title>{`${d.date}: ${formatTokens(d.totalTokens)} tokens, ${d.runs} requests, estimated cost ${formatEstimatedCost(d)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{daily[0]?.date}</span>
        <span>{daily[daily.length - 1]?.date}</span>
      </div>
    </figure>
  );
}

function AgentTable({ title, rows }: { title: string; rows: { key: string; name: string; totals: AgentTotals }[] }) {
  return (
    <section aria-label={`Agents ${title}`}>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">None</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-1 font-normal">Name</th>
              <th className="py-1 font-normal">Requests</th>
              <th className="py-1 font-normal">Tokens</th>
              <th className="py-1 font-normal" title={ESTIMATE_NOTE}>Estimated cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-border">
                <td className="py-1">{r.name}</td>
                <td className="py-1">{r.totals.runs}</td>
                <td className="py-1">{formatTokens(r.totals.totalTokens)}</td>
                <td className="py-1">{formatEstimatedCost(r.totals)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
