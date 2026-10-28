import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { budgetPeriod } from './budget.fixture';
import { BudgetBar } from './budget-bar';

const bar = (over = {}, scope: 'global' | 'project' = 'project') =>
  render(<ul><BudgetBar status={budgetPeriod(scope, 'day', over)} /></ul>);

describe('BudgetBar', () => {
  it('shows spent, limit, percent, state and the UTC reset with an accessible progressbar', () => {
    bar({ spent: 4, limit: 10, percent: 40 });
    const pb = screen.getByRole('progressbar', { name: 'Project day (estimated) spend' });
    expect(pb).toHaveAttribute('aria-valuenow', '40');
    expect(pb).toHaveAttribute('aria-valuetext', '$4.00 estimated of $10.00, 40%');
    expect(screen.getByText('Within budget')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByText(/resets 2026-03-10 00:00 UTC \(UTC\)/)).toBeInTheDocument();
  });

  it('says No limit instead of drawing a bar', () => {
    bar({ limit: null, percent: null });
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getAllByText(/No limit/).length).toBeGreaterThan(0);
  });

  it('clamps the fill at 100 but keeps the real overspend numbers', () => {
    bar({ spent: 25, limit: 10, percent: 250, state: 'hard' });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('250%')).toBeInTheDocument();
    expect(screen.getByText(/\$25\.00 estimated/)).toBeInTheDocument();
    expect(screen.getByText('Limit reached')).toBeInTheDocument();
  });

  it('handles a zero limit without a percent or NaN', () => {
    bar({ limit: 0, percent: null, state: 'hard', spent: 0 });
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText('Zero limit')).toBeInTheDocument();
    expect(screen.getByText(/stops new automatic dispatch immediately/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it('keeps a priced zero, no usage and all-unpriced apart, and flags a lower bound', () => {
    const { unmount } = bar({ spent: 0, pricing: 'complete' });
    expect(screen.getByText(/\$0\.00 estimated \(priced, true zero\)/)).toBeInTheDocument();
    unmount();
    const b = bar({ spent: 0, pricing: 'empty', pricedRows: 0, totalRows: 0 });
    expect(screen.getByText(/No usage recorded/)).toBeInTheDocument();
    b.unmount();
    const c = bar({ spent: 0, pricing: 'unknown', pricedRows: 0, totalRows: 3, unpricedRows: 3, incomplete: true });
    expect(screen.getByText(/Spend unknown: 3 of 3 rows have no price/)).toBeInTheDocument();
    expect(screen.queryByText(/true zero/)).not.toBeInTheDocument();
    c.unmount();
    bar({ spent: 2, pricing: 'partial', totalRows: 4, pricedRows: 3, unpricedRows: 1, incomplete: true });
    expect(screen.getByText(/\$2\.00\+ estimated \(lower bound; 1 of 4 rows have no price\)/)).toBeInTheDocument();
    expect(screen.getByText('1 unpriced rows are not in the total.')).toBeInTheDocument();
  });

  it('names the variable of an invalid global configuration', () => {
    bar({ state: 'hard', limit: null, reason: { kind: 'configError', variable: 'GLOBAL_DAILY_BUDGET_USD', message: 'GLOBAL_DAILY_BUDGET_USD is invalid' } }, 'global');
    expect(screen.getByText('Hard stop: invalid configuration')).toBeInTheDocument();
    expect(screen.getByText('GLOBAL_DAILY_BUDGET_USD is invalid')).toBeInTheDocument();
  });
});
