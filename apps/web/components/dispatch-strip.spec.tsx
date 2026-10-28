import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BudgetBlocker, RepoDispatchReport } from '@/lib/api';
import { DispatchStrip } from './dispatch-strip';

const base: RepoDispatchReport = {
  repoId: 'r', fullName: 'gilde-dev/gilde', queued: 2, fired: 0, reason: 'none', detail: null, resetsAt: null,
  waitingOnDependencies: 0, waitingOnRevisions: 0,
};

describe('DispatchStrip', () => {
  it('renders nothing when no repo is held back', () => {
    const { container } = render(
      <DispatchStrip repos={[base, { ...base, reason: 'repo_paused', detail: 'x', queued: 0 }, { ...base, waitingOnDependencies: 2 }]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('explains the daily limit with the reset time', () => {
    render(<DispatchStrip repos={[{ ...base, reason: 'daily_limit', detail: '30/30', resetsAt: '2026-03-05T00:00:00.000Z' }]} />);
    expect(screen.getByText(/Daily limit reached 30\/30, resets at/)).toBeTruthy();
  });

  describe('budget', () => {
    const blocker = (over: Partial<BudgetBlocker> = {}): BudgetBlocker => ({
      scope: 'project', projectId: 'p', period: 'day', kind: 'limit', variable: null, limit: 10, spent: 10.5,
      startsAt: '2026-03-05T00:00:00.000Z', resetsAt: '2026-03-06T00:00:00.000Z', message: '', ...over,
    });

    it('shows scope, period, estimated spend and the reset for one blocker', () => {
      render(<DispatchStrip repos={[{ ...base, reason: 'budget', detail: 'x', resetsAt: '2026-03-06T00:00:00.000Z', budget: { blockers: [blocker()], recovery: 'reset', error: false } }]} />);
      const text = screen.getByRole('listitem').textContent;
      expect(text).toContain('Stopped by estimated budget: project day $10.50 of $10.00 estimated, resets 2026-03-06 00:00 UTC');
      expect(text).toContain('Earliest automatic recovery 2026-03-06 00:00 UTC');
    });

    it('lists all simultaneous blockers and only promises the latest reset', () => {
      const week = blocker({ scope: 'global', projectId: null, period: 'week', resetsAt: '2026-03-09T00:00:00.000Z', spent: 50, limit: 40 });
      render(<DispatchStrip repos={[{ ...base, reason: 'budget', resetsAt: '2026-03-09T00:00:00.000Z', budget: { blockers: [blocker(), week], recovery: 'reset', error: false } }]} />);
      const text = screen.getByRole('listitem').textContent ?? '';
      expect(text).toContain('project day');
      expect(text).toContain('global week $50.00 of $40.00');
      expect(text).toContain('Earliest automatic recovery 2026-03-09 00:00 UTC (when all blockers have reset)');
      expect(text).not.toContain('Earliest automatic recovery 2026-03-06');
    });

    it('makes no reset promise for a config error and names the variable', () => {
      const bad = blocker({ scope: 'global', projectId: null, kind: 'configError', variable: 'GLOBAL_DAILY_BUDGET_USD', limit: null });
      render(<DispatchStrip repos={[{ ...base, reason: 'budget', resetsAt: null, budget: { blockers: [bad], recovery: 'manual', error: false } }]} />);
      const text = screen.getByRole('listitem').textContent ?? '';
      expect(text).toContain('GLOBAL_DAILY_BUDGET_USD is invalid');
      expect(text).toContain('Needs a limit or configuration change');
      expect(text).not.toContain('Earliest automatic recovery');
    });

    it('says honestly when the budget could not be checked', () => {
      render(<DispatchStrip repos={[{ ...base, reason: 'budget', budget: { blockers: [], recovery: 'unknown', error: true } }]} />);
      expect(screen.getByRole('listitem').textContent).toContain('could not be checked');
      expect(screen.getByRole('listitem').textContent).not.toContain('$0');
    });
  });

  it('explains a paused repo and waiting jobs', () => {
    render(
      <DispatchStrip
        repos={[{ ...base, reason: 'repo_paused', detail: 'HTTP 401', waitingOnDependencies: 2, waitingOnRevisions: 1 }]}
      />,
    );
    const li = screen.getByRole('listitem');
    expect(li.textContent).toContain('Repo paused: HTTP 401');
    expect(li.textContent).toContain('2 jobs waiting on dependencies');
    expect(li.textContent).toContain('1 job waiting for a proposal decision');
  });
});
