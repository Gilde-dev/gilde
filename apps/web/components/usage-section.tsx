'use client';

import { useCallback } from 'react';
import { api, type Usage, type UsageTotals } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';

const POLL_MS = 60_000;

export const formatTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n));
/** A dash when the cost is unknown (no price in LLM_PRICES). */
export const formatCost = (usd: number | null) => (usd === null ? '–' : `$${usd.toFixed(usd < 1 ? 4 : 2)}`);

export function UsageSection({ days }: { days: number }) {
  const fetchUsage = useCallback(() => api.getUsage(days), [days]);
  const usage = usePolling(fetchUsage, POLL_MS);
  return (
    <section aria-label="Usage" className="space-y-4 border-t border-border p-4">
      <h2 className="font-serif text-lg font-semibold">Usage</h2>
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

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
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
