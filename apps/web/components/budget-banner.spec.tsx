import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { budgetStatus } from './budget.fixture';
import { BudgetBanner } from './budget-banner';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
afterEach(() => vi.restoreAllMocks());

const blocker = (scope: 'global' | 'project', period: 'day' | 'week') => ({
  scope, projectId: scope === 'project' ? 'p1' : null, period, kind: 'limit' as const, variable: null, limit: 10, spent: 12,
  startsAt: '2026-03-09T00:00:00.000Z', resetsAt: period === 'day' ? '2026-03-10T00:00:00.000Z' : '2026-03-16T00:00:00.000Z', message: 'x',
});

describe('BudgetBanner', () => {
  it('shows nothing while loading and when everything is ok', async () => {
    const get = vi.spyOn(api, 'getBudget').mockResolvedValue(budgetStatus());
    const { container } = render(<BudgetBanner projectId="p1" />);
    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(get).toHaveBeenCalledWith('p1'));
    expect(container).toBeEmptyDOMElement();
  });

  it('warns for a soft project period with a settings link that keeps ?project=', async () => {
    vi.spyOn(api, 'getBudget').mockResolvedValue(budgetStatus({ pDay: { state: 'soft', limit: 10, percent: 85, spent: 8.5 } }));
    render(<BudgetBanner projectId="p1" />);
    const banner = await screen.findByRole('status', { name: 'Estimated budget' });
    expect(banner).toHaveClass('text-warning');
    expect(banner).toHaveTextContent('Estimated budget warning');
    expect(screen.getByRole('link', { name: 'Project budget settings' })).toHaveAttribute('href', '/settings/projects/p1?project=p1');
  });

  it('shows a danger banner for a global hard stop while the project is fine', async () => {
    vi.spyOn(api, 'getBudget').mockResolvedValue(
      budgetStatus({
        gDay: { state: 'hard', limit: 10, percent: 120, spent: 12 },
        status: { hardBlocked: true, recovery: 'reset', recoversAt: '2026-03-10T00:00:00.000Z', blockers: [blocker('global', 'day')] },
      }),
    );
    render(<BudgetBanner projectId="p1" />);
    const banner = await screen.findByRole('status', { name: 'Estimated budget' });
    expect(banner).toHaveClass('text-danger');
    expect(banner).toHaveTextContent('Dispatch paused by budget until 2026-03-10 00:00 UTC');
    expect(banner).toHaveTextContent('Global day');
    expect(banner).not.toHaveTextContent('Project day');
    expect(banner).toHaveTextContent('manual pause is separate');
    expect(banner).toHaveTextContent('not a promise');
  });

  it('lists simultaneous blockers and uses the latest reset, not the earlier one', async () => {
    vi.spyOn(api, 'getBudget').mockResolvedValue(
      budgetStatus({
        pDay: { state: 'hard', limit: 10, percent: 120, spent: 12 },
        gWeek: { state: 'hard', limit: 50, percent: 110, spent: 55 },
        status: { hardBlocked: true, recovery: 'reset', recoversAt: '2026-03-16T00:00:00.000Z', blockers: [blocker('project', 'day'), blocker('global', 'week')] },
      }),
    );
    render(<BudgetBanner projectId="p1" />);
    const banner = await screen.findByRole('status', { name: 'Estimated budget' });
    expect(banner).toHaveTextContent('until 2026-03-16 00:00 UTC');
    expect(banner).toHaveTextContent('Project day');
    expect(banner).toHaveTextContent('Global week');
  });

  it('needs a manual change for a zero limit or invalid configuration', async () => {
    vi.spyOn(api, 'getBudget').mockResolvedValue(
      budgetStatus({
        gWeek: { state: 'hard', limit: null, reason: { kind: 'configError', variable: 'GLOBAL_WEEKLY_BUDGET_USD', message: 'invalid' } },
        status: { hardBlocked: true, recovery: 'manual', recoversAt: null },
      }),
    );
    render(<BudgetBanner projectId="p1" />);
    const banner = await screen.findByRole('status', { name: 'Estimated budget' });
    expect(banner).toHaveTextContent('until a limit or configuration changes');
    expect(banner).toHaveTextContent('GLOBAL_WEEKLY_BUDGET_USD is invalid');
  });

  it('says the budget is unavailable on an error, never ok', async () => {
    vi.spyOn(api, 'getBudget').mockRejectedValue(new Error('boom'));
    render(<BudgetBanner projectId="p1" />);
    expect(await screen.findByText('Estimated budget status is unavailable right now.')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Estimated budget' })).not.toBeInTheDocument();
  });

  it('never shows the previous project status for the new project', async () => {
    const get = vi.spyOn(api, 'getBudget').mockImplementation(async (id) =>
      id === 'p1' ? budgetStatus({ pDay: { state: 'soft', limit: 10, percent: 90 } }) : new Promise(() => {}),
    );
    const { rerender } = render(<BudgetBanner projectId="p1" />);
    await screen.findByRole('status', { name: 'Estimated budget' });
    rerender(<BudgetBanner projectId="p2" />);
    expect(screen.queryByRole('status', { name: 'Estimated budget' })).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('p2');
  });
});
