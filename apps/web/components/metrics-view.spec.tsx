import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_STATUSES, api, type Metrics, type ScoutActivity, type Usage } from '@/lib/api';
import { budgetStatus } from './budget.fixture';
import { agentUsage } from './agent-usage.fixture';
import { MetricsView, formatMinutes } from './metrics-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));


vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const empty: Metrics = {
  days: 30,
  jobs: { total: 0, countByStatus: Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Metrics['jobs']['countByStatus'] },
  mergeRate: null,
  firstPassRate: null,
  avgAttempts: null,
  timeToMerge: { median: null, p90: null },
  runs: { total: 0, byOutcome: { done: 0, partial: 0, blocked: 0, none: 0 }, byCiConclusion: { none: 0 }, gateFailures: 0 },
  byInstructionsVersion: [],
  daily: [{ date: '2026-03-10', created: 0, merged: 0, parked: 0 }],
};

const withData: Metrics = {
  ...empty,
  jobs: { ...empty.jobs, total: 4 },
  mergeRate: 0.75,
  firstPassRate: 0.5,
  avgAttempts: 1.5,
  timeToMerge: { median: 25, p90: 130 },
  runs: { total: 5, byOutcome: { done: 3, partial: 1, blocked: 0, none: 1 }, byCiConclusion: { success: 3, failure: 1, none: 1 }, gateFailures: 2 },
  byInstructionsVersion: [
    { version: 'abc123def456', runs: 4, mergedJobs: 3, firstPassRate: 0.67, avgAttempts: 1.3 },
    { version: 'none', runs: 1, mergedJobs: 0, firstPassRate: null, avgAttempts: null },
  ],
  daily: [
    { date: '2026-03-09', created: 2, merged: 0, parked: 0 },
    { date: '2026-03-10', created: 2, merged: 3, parked: 1 },
  ],
};

const noUsage: Usage = { days: 30, totals: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costUsd: null, runs: 0 }, daily: [], byModel: [], byKind: [], byUser: [] };

const activity = (over: Partial<ScoutActivity> = {}): ScoutActivity => ({
  projectId: 'p1', enabled: true, model: 'openai/scout', scoutUserId: 'bot', suggestionsThisWeek: 2, weekStart: '2026-10-26', lastWakeAt: '2026-10-27T06:00:00.000Z', ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'listProjects').mockResolvedValue([{ id: 'p1', name: 'Proj' } as never]);
  vi.spyOn(api, 'getUsage').mockResolvedValue(noUsage);
  vi.spyOn(api, 'getAgentUsage').mockResolvedValue(agentUsage());
  vi.spyOn(api, 'scoutActivity').mockResolvedValue(activity());
  vi.spyOn(api, 'listRepos').mockResolvedValue([{ id: 'r1', fullName: 'o/r' } as never]);
  vi.spyOn(api, 'getBudget').mockImplementation(async (id) => budgetStatus({ projectId: id }));
});

describe('MetricsView', () => {
  it('renders tiles, chart and breakdowns', async () => {
    vi.spyOn(api, 'getMetrics').mockResolvedValue(withData);
    render(<MetricsView />);
    const summary = await screen.findByRole('region', { name: 'Summary' });
    expect(summary).toHaveTextContent('Merge rate');
    expect(summary).toHaveTextContent('75%');
    expect(summary).toHaveTextContent('50%');
    expect(summary).toHaveTextContent('1.5');
    expect(summary).toHaveTextContent('25m');
    expect(summary).toHaveTextContent('2.2h');
    expect(summary).toHaveTextContent('Gate failures');
    expect(screen.getByRole('region', { name: 'Daily activity' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Run outcomes' })).toHaveTextContent('done');
    expect(screen.getByRole('region', { name: 'CI conclusions' })).toHaveTextContent('failure');
    const versions = screen.getByRole('region', { name: 'By instructions version' });
    expect(versions).toHaveTextContent('abc123def456');
    expect(versions).toHaveTextContent('67%');
    expect(versions).toHaveTextContent('none');
  });

  it('shows an empty state with an empty database', async () => {
    vi.spyOn(api, 'getMetrics').mockResolvedValue(empty);
    render(<MetricsView />);
    expect(await screen.findByText('No jobs in the last 30 days.')).toBeInTheDocument();
  });

  it('refetches when the period and filters change', async () => {
    const getMetrics = vi.spyOn(api, 'getMetrics').mockResolvedValue(withData);
    render(<MetricsView />);
    await screen.findByRole('region', { name: 'Summary' });
    expect(getMetrics).toHaveBeenLastCalledWith({ projectId: 'p1', repoId: undefined, days: 30 });

    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(getMetrics).toHaveBeenLastCalledWith({ projectId: 'p1', repoId: undefined, days: 7 }));

    await screen.findByRole('option', { name: 'o/r' });
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: 'r1' } });
    await waitFor(() => expect(getMetrics).toHaveBeenLastCalledWith({ projectId: 'p1', repoId: 'r1', days: 7 }));
  });
});

describe('MetricsView agent usage', () => {
  it('shows co-pilot and agents sections, scoped to the selected project and period', async () => {
    vi.spyOn(api, 'getMetrics').mockResolvedValue(empty);
    const spy = vi.spyOn(api, 'getAgentUsage');
    render(<MetricsView />);
    expect(await screen.findByRole('region', { name: 'Usage' })).toHaveTextContent('Co-pilot usage');
    const agents = await screen.findByRole('region', { name: 'Agents (Claude Code)' });
    expect(agents).toHaveTextContent('Agents (Claude Code)');
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(30, 'p1'));
    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(7, 'p1'));
  });
});

describe('formatMinutes', () => {
  it('formats minutes, hours and days', () => {
    expect(formatMinutes(null)).toBe('–');
    expect(formatMinutes(25)).toBe('25m');
    expect(formatMinutes(130)).toBe('2.2h');
    expect(formatMinutes(60 * 72)).toBe('3.0d');
  });
});

describe('MetricsView Verkenner section', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getMetrics').mockResolvedValue(empty);
  });
  const section = () => screen.findByRole('region', { name: 'Verkenner' });

  it('shows on, the weekly suggestions and the actual last wake, with the project and week scope', async () => {
    render(<MetricsView />);
    const s = await section();
    await waitFor(() => expect(s).toHaveTextContent('Suggestions this week'));
    await waitFor(() => expect(within(s).getByText('2')).toBeInTheDocument());
    expect(s).toHaveTextContent('This project');
    expect(s).toHaveTextContent('Monday 2026-10-26 (UTC)');
    expect(s).toHaveTextContent(new Date('2026-10-27T06:00:00.000Z').toLocaleString());
    expect(within(s).getAllByText('On').length).toBeGreaterThan(0);
    expect(api.scoutActivity).toHaveBeenCalledWith('p1');
  });

  it('shows off with its history, zero suggestions and Never for a null last wake', async () => {
    vi.spyOn(api, 'scoutActivity').mockResolvedValue(activity({ enabled: false, model: null, suggestionsThisWeek: 0, lastWakeAt: null }));
    render(<MetricsView />);
    const s = await section();
    await waitFor(() => expect(within(s).getByText('Never')).toBeInTheDocument());
    expect(within(s).getAllByText('Off').length).toBeGreaterThan(0);
    expect(within(s).getByText('0')).toBeInTheDocument();
  });

  it('is independent of the factory period and repo filters', async () => {
    render(<MetricsView />);
    await section();
    await waitFor(() => expect(api.scoutActivity).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    await screen.findByRole('option', { name: 'o/r' });
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: 'r1' } });
    await waitFor(() => expect(api.getMetrics).toHaveBeenLastCalledWith({ projectId: 'p1', repoId: 'r1', days: 7 }));
    expect(api.scoutActivity).toHaveBeenCalledTimes(1);
  });

  it('shows loading placeholders, not zeros, while the read is pending', async () => {
    vi.spyOn(api, 'scoutActivity').mockReturnValue(new Promise(() => {}));
    render(<MetricsView />);
    const s = await section();
    expect(within(s).getAllByText('…').length).toBe(3);
    expect(within(s).queryByText('0')).toBeNull();
    expect(within(s).queryByText('Never')).toBeNull();
  });

  it('shows an error and dashes, not zeros, when the read fails', async () => {
    vi.spyOn(api, 'scoutActivity').mockRejectedValue(new Error('scout activity unavailable'));
    render(<MetricsView />);
    const s = await section();
    expect(await within(s).findByRole('alert')).toHaveTextContent('scout activity unavailable');
    expect(within(s).getAllByText('–').length).toBe(3);
    expect(within(s).queryByText('0')).toBeNull();
  });
});

describe('Budget section', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getMetrics').mockResolvedValue(empty);
  });
  const section = () => screen.findByRole('region', { name: 'Estimated budget' });

  it('shows project and global day and week bars, labelled estimated, with no limit as text', async () => {
    render(<MetricsView />);
    const s = await section();
    for (const name of ['Project day (estimated)', 'Project week (estimated)', 'Global day (estimated)', 'Global week (estimated)']) {
      expect(within(s).getByRole('listitem', { name })).toBeInTheDocument();
    }
    expect(within(s).queryByRole('progressbar')).toBeNull();
    expect(s).toHaveTextContent('No limit');
    expect(s).toHaveTextContent('(UTC)');
  });

  it('shows spend, percent, state and overspend, and ignores the days and repo filters', async () => {
    vi.spyOn(api, 'getBudget').mockResolvedValue(
      budgetStatus({ pDay: { spent: 12, limit: 10, percent: 120, state: 'hard' }, gWeek: { spent: 4, limit: 10, percent: 40 } }),
    );
    render(<MetricsView />);
    const s = await section();
    const day = within(s).getByRole('listitem', { name: 'Project day (estimated)' });
    expect(day).toHaveTextContent('120%');
    expect(day).toHaveTextContent('Limit reached');
    expect(within(day).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: 'r1' } });
    await waitFor(() => expect(api.getMetrics).toHaveBeenCalledWith({ projectId: 'p1', repoId: 'r1', days: 7 }));
    expect(api.getBudget).toHaveBeenCalledTimes(1);
    expect(api.getBudget).toHaveBeenCalledWith('p1');
  });

  it('shows loading and an error, never a zero', async () => {
    vi.spyOn(api, 'getBudget').mockImplementation(() => new Promise(() => {}));
    const { unmount } = render(<MetricsView />);
    expect(await screen.findByText('Loading budget…')).toBeInTheDocument();
    unmount();
    vi.spyOn(api, 'getBudget').mockRejectedValue(new Error('nope'));
    render(<MetricsView />);
    expect(await screen.findByText('Budget could not be loaded: nope')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('keeps the agent usage section', async () => {
    render(<MetricsView />);
    await section();
    expect(screen.getAllByRole('region').length).toBeGreaterThan(1);
  });
});
