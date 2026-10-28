import Link from 'next/link';
import { TriangleAlert } from 'lucide-react';
import { useCallback } from 'react';
import { api, type BudgetPeriodStatus } from '@/lib/api';
import { periodName, scopeName, spendText, usd, utc } from '@/lib/budget';
import { usePolling } from '@/lib/use-polling';
import { withProject } from '@/lib/use-project';
import { cn } from '@/lib/utils';
import { Icon } from './ui/icon';

const POLL_MS = 30_000;

function line(p: BudgetPeriodStatus): string {
  const what = `${scopeName(p)} ${periodName(p)}`;
  if (p.reason?.kind === 'configError') return `${what}: ${p.reason.variable ?? 'the limit setting'} is invalid (a reset does not clear it)`;
  return `${what}: ${spendText(p)} of ${p.limit === null ? 'no limit' : usd(p.limit)}, resets ${utc(p.resetsAt)}`;
}

/**
 * Warns when the selected project's or the global estimated budget is soft or hard. Nothing is shown while loading;
 * an unavailable budget is said so rather than reported as fine. Does not touch the job list or its counts.
 */
export function BudgetBanner({ projectId }: { projectId: string }) {
  const fetchBudget = useCallback(() => api.getBudget(projectId), [projectId]);
  const budget = usePolling(fetchBudget, POLL_MS);
  // After a project switch the first render still holds the previous project's data.
  const data = budget.data?.project?.projectId === projectId ? budget.data : undefined;
  if (!data) {
    return budget.error ? (
      <p role="status" className="mx-4 mt-4 text-sm text-muted-foreground">
        Estimated budget status is unavailable right now.
      </p>
    ) : null;
  }
  const periods = [data.project, data.global]
    .flatMap((s) => (s ? [s.day, s.week] : []))
    .filter((p) => p.state !== 'ok');
  if (periods.length === 0) return null;
  const hard = data.hardBlocked || periods.some((p) => p.state === 'hard');
  const hardPeriods = periods.filter((p) => p.state === 'hard');
  const shown = hard ? hardPeriods : periods;
  const until =
    data.recovery === 'reset' && data.recoversAt
      ? `until ${utc(data.recoversAt)}`
      : 'until a limit or configuration changes';
  return (
    <div
      role="status"
      aria-label="Estimated budget"
      className={cn(
        'mx-4 mt-4 space-y-1 rounded-lg border px-3 py-2 text-sm',
        hard ? 'border-danger/40 bg-danger-soft text-danger' : 'border-warning/40 bg-warning-soft text-warning',
      )}
    >
      <p className="flex items-center gap-2 font-medium">
        <Icon icon={TriangleAlert} size={14} />
        {hard ? `Dispatch paused by budget ${until}` : 'Estimated budget warning: nearing a limit'}
      </p>
      <ul className="list-disc pl-6">
        {shown.map((p) => (
          <li key={`${p.scope}-${p.period}`}>
            {line(p)}
          </li>
        ))}
      </ul>
      {hard && (
        <p>
          Only new automatic dispatch is stopped; running work continues. A manual pause is separate and stays in place. The time is not a
          promise: it is the latest reset among all blockers, and spend or limits may change.
        </p>
      )}
      <p>
        <Link href={withProject(`/settings/projects/${encodeURIComponent(projectId)}`, projectId)} className="underline">
          Project budget settings
        </Link>
      </p>
    </div>
  );
}
