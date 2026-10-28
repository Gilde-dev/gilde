import type { BudgetPeriodStatus, BudgetStatus } from '@/lib/api';

export const budgetPeriod = (
  scope: 'global' | 'project',
  period: 'day' | 'week',
  over: Partial<BudgetPeriodStatus> = {},
): BudgetPeriodStatus => ({
  scope, period, projectId: scope === 'project' ? 'p1' : null,
  startsAt: period === 'day' ? '2026-03-09T00:00:00.000Z' : '2026-03-09T00:00:00.000Z',
  resetsAt: period === 'day' ? '2026-03-10T00:00:00.000Z' : '2026-03-16T00:00:00.000Z',
  spent: 1, pricedRows: 1, totalRows: 1, unpricedRows: 0, pricing: 'complete', incomplete: false,
  limit: null, percent: null, softPct: 80, state: 'ok', reason: null, ...over,
});

export interface BudgetOverrides {
  gDay?: Partial<BudgetPeriodStatus>;
  gWeek?: Partial<BudgetPeriodStatus>;
  pDay?: Partial<BudgetPeriodStatus>;
  pWeek?: Partial<BudgetPeriodStatus>;
  status?: Partial<BudgetStatus>;
  projectId?: string;
}

/** A status for project `projectId` (default p1); all periods are ok without a limit unless overridden. */
export function budgetStatus(o: BudgetOverrides = {}): BudgetStatus {
  const projectId = o.projectId ?? 'p1';
  const p = (period: 'day' | 'week', over?: Partial<BudgetPeriodStatus>) => ({ ...budgetPeriod('project', period, over), projectId });
  return {
    evaluatedAt: '2026-03-09T12:00:00.000Z',
    global: { day: budgetPeriod('global', 'day', o.gDay), week: budgetPeriod('global', 'week', o.gWeek) },
    project: { projectId, day: p('day', o.pDay), week: p('week', o.pWeek) },
    blockers: [], hardBlocked: false, recovery: 'none', recoversAt: null, ...o.status,
  };
}
