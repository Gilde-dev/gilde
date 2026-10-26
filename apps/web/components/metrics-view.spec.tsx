import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_STATUSES, api, type Metrics, type Usage } from '@/lib/api';
import { MetricsView, formatMinutes } from './metrics-view';

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

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'listProjects').mockResolvedValue([{ id: 'p1', name: 'Proj' } as never]);
  vi.spyOn(api, 'getUsage').mockResolvedValue(noUsage);
  vi.spyOn(api, 'listRepos').mockResolvedValue([{ id: 'r1', fullName: 'o/r' } as never]);
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
    expect(screen.getByRole('link', { name: 'Metrics' })).toHaveAttribute('aria-current', 'page');
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
    expect(getMetrics).toHaveBeenLastCalledWith({ projectId: undefined, repoId: undefined, days: 30 });

    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(getMetrics).toHaveBeenLastCalledWith({ projectId: undefined, repoId: undefined, days: 7 }));

    await screen.findByRole('option', { name: 'Proj' });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p1' } });
    await waitFor(() => expect(getMetrics).toHaveBeenLastCalledWith({ projectId: 'p1', repoId: undefined, days: 7 }));

    await screen.findByRole('option', { name: 'o/r' });
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: 'r1' } });
    await waitFor(() => expect(getMetrics).toHaveBeenLastCalledWith({ projectId: 'p1', repoId: 'r1', days: 7 }));
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
