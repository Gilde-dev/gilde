import type { AgentTotals } from '@/lib/api';

export const formatTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n));

export const ESTIMATE_NOTE =
  'Costs are estimates reported by Claude Code. Under a subscription they are notional, not what you are billed.';

/** "unavailable" when no request carried an estimate (never $0); a "+" and the unknown count when only some did. */
export function formatEstimatedCost(t: Pick<AgentTotals, 'costUsd' | 'costPartial' | 'costUnknownRequests'>): string {
  if (t.costUsd === null) return 'unavailable';
  const v = `$${t.costUsd.toFixed(t.costUsd < 1 ? 4 : 2)}`;
  return t.costPartial ? `${v}+ (${t.costUnknownRequests} requests unknown)` : v;
}

/** Share of `part` in `whole` by total tokens; null when there are no tokens at all (no denominator). */
export function tokenShare(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(part / whole < 0.1 ? 1 : 0)}%` : '–';
}

/** The four token categories of a total, for tables and cards. */
export function AgentTokenCategories({ t }: { t: AgentTotals }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
      {(
        [
          ['Uncached input', t.uncachedInputTokens],
          ['Cache read', t.cachedInputTokens],
          ['Cache creation', t.cacheCreationTokens],
          ['Output', t.outputTokens],
        ] as const
      ).map(([label, v]) => (
        <div key={label}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="tabular-nums">{formatTokens(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Compact agent usage for a job, run or feature (lifetime recorded usage).
 * `runs === 0` means no telemetry arrived (yet), which is not the same as a recorded zero.
 */
export function AgentUsageSummary({ t, label }: { t: AgentTotals; label: string }) {
  if (t.runs === 0) {
    return <p className="text-sm text-muted-foreground">{label}: no Claude Code telemetry received yet.</p>;
  }
  const cost = formatEstimatedCost(t);
  return (
    <section aria-label={label} className="space-y-1 text-sm">
      <p>
        <span className="font-medium">{label}:</span> {formatTokens(t.totalTokens)} tokens ({t.totalTokens.toLocaleString('en-US')}) · {t.runs}{' '}
        {t.runs === 1 ? 'request' : 'requests'} ·{' '}
        <span title={ESTIMATE_NOTE}>
          estimated cost <span className={t.costUsd === null ? 'text-muted-foreground' : undefined}>{cost}</span>
        </span>
      </p>
      <AgentTokenCategories t={t} />
      <p className="text-xs text-muted-foreground">{ESTIMATE_NOTE}</p>
    </section>
  );
}
