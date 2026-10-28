import type { BudgetPeriodStatus, BudgetState } from '@/lib/api';

export const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/** Two decimals, four for amounts below one cent so a small spend is not shown as a true zero. */
export function usd(n: number): string {
  return `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

export const periodName = (p: Pick<BudgetPeriodStatus, 'period'>) => (p.period === 'day' ? 'day' : 'week');
export const scopeName = (p: Pick<BudgetPeriodStatus, 'scope'>) => (p.scope === 'global' ? 'Global' : 'Project');

/**
 * What was spent, keeping empty usage, a priced zero, unpriced rows and a lower bound apart.
 * Always "estimated": with a subscription the amount is notional consumption, not a bill.
 */
export function spendText(p: BudgetPeriodStatus): string {
  switch (p.pricing) {
    case 'empty':
      return 'No usage recorded';
    case 'unknown':
      return `Spend unknown: ${p.unpricedRows} of ${p.totalRows} rows have no price`;
    case 'partial':
      return `${usd(p.spent)}+ estimated (lower bound; ${p.unpricedRows} of ${p.totalRows} rows have no price)`;
    default:
      return p.spent === 0 ? '$0.00 estimated (priced, true zero)' : `${usd(p.spent)} estimated`;
  }
}

export function limitText(p: BudgetPeriodStatus): string {
  if (p.reason?.kind === 'configError') return `Invalid setting${p.reason.variable ? ` (${p.reason.variable})` : ''}`;
  if (p.limit === null) return 'No limit';
  if (p.limit === 0) return 'Limit $0.00 (stops new automatic dispatch immediately)';
  return `Limit ${usd(p.limit)}`;
}

/** The percentage, or why there is none. Never NaN, never hides overspend. */
export function percentText(p: BudgetPeriodStatus): string {
  if (p.percent !== null) return `${Math.floor(p.percent)}%`;
  if (p.reason?.kind === 'configError') return 'Invalid setting';
  if (p.limit === 0) return 'Zero limit';
  return 'No limit';
}

/** Bar fill 0..100. Only the visual is clamped; the numbers stay as reported. */
export function fillPercent(p: BudgetPeriodStatus): number {
  return p.percent === null ? 0 : Math.min(100, Math.max(0, p.percent));
}

export const stateLabel = (p: BudgetPeriodStatus): string =>
  p.reason?.kind === 'configError' ? 'Hard stop: invalid configuration' : { ok: p.limit === null ? 'No limit' : 'Within budget', soft: 'Warning', hard: 'Limit reached' }[p.state];

export const stateVariant: Record<BudgetState, 'success' | 'warning' | 'danger'> = { ok: 'success', soft: 'warning', hard: 'danger' };

/** One-line summary: used for field hints, bar text alternatives and the banner. */
export function periodSummary(p: BudgetPeriodStatus): string {
  return `${spendText(p)} · ${limitText(p)} · resets ${utc(p.resetsAt)}`;
}
