import type { BudgetPeriodStatus } from '@/lib/api';
import { fillPercent, limitText, percentText, periodName, scopeName, spendText, stateLabel, stateVariant, usd, utc } from '@/lib/budget';
import { cn } from '@/lib/utils';
import { Badge } from './ui/badge';

const FILL = { ok: 'bg-success-solid', soft: 'bg-warning-solid', hard: 'bg-danger-solid' } as const;

/**
 * One estimated-budget period: scope, spend, limit, percent, state, unpriced rows and the UTC reset.
 * The progressbar only exists when there is a percentage; no limit, a zero limit and an invalid setting are text.
 */
export function BudgetBar({ status: p }: { status: BudgetPeriodStatus }) {
  const title = `${scopeName(p)} ${periodName(p)} (estimated)`;
  const hasBar = p.percent !== null;
  return (
    <li aria-label={title} className="space-y-1 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-md font-semibold">{title}</h4>
        <Badge variant={p.limit === null && p.state === 'ok' ? 'neutral' : stateVariant[p.state]}>{stateLabel(p)}</Badge>
        <span className="ml-auto text-sm text-muted-foreground">{percentText(p)}</span>
      </div>
      {hasBar && (
        <div
          role="progressbar"
          aria-label={`${title} spend`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fillPercent(p))}
          aria-valuetext={`${spendText(p)} of ${p.limit === null ? 'no limit' : usd(p.limit)}, ${percentText(p)}`}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div className={cn('h-full rounded-full', FILL[p.state])} style={{ width: `${fillPercent(p)}%` }} />
        </div>
      )}
      <p className="text-sm">
        {spendText(p)} · {limitText(p)}
      </p>
      {p.reason?.kind === 'configError' && <p className="text-sm text-danger">{p.reason.message}</p>}
      {p.unpricedRows > 0 && p.pricing !== 'unknown' && <p className="text-sm text-muted-foreground">{p.unpricedRows} unpriced rows are not in the total.</p>}
      <p className="text-sm text-muted-foreground">
        {utc(p.startsAt)} to {utc(p.resetsAt)} · resets {utc(p.resetsAt)} (UTC)
      </p>
    </li>
  );
}
