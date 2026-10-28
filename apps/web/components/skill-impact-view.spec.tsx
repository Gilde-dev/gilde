import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type ImpactGroup, type SkillImpact } from '@/lib/api';
import { IMPACT_NOTE, SkillImpactView } from './skill-impact-view';

const group = (over: Partial<ImpactGroup> = {}): ImpactGroup => ({
  n: 12,
  insufficient: false,
  counts: { done: 9, partial: 2, blocked: 1, merged: 6, rejectedOrParked: 3, ciFailed: 4 },
  rates: { done: 0.75, partial: 0.1667, blocked: 0.0833, merged: 0.5, rejectedOrParked: 0.25, ciFailed: 0.3333 },
  avgRevisionRounds: 1.5,
  medianTokens: 123456,
  tokensN: 10,
  ...over,
});

const thin = group({
  n: 3,
  insufficient: true,
  counts: { done: 2, partial: 0, blocked: 1, merged: 2, rejectedOrParked: 0, ciFailed: 0 },
  rates: null,
  avgRevisionRounds: null,
  medianTokens: null,
  tokensN: 0,
});

const impact: SkillImpact = {
  days: 30,
  minRuns: 10,
  skills: [
    {
      name: 'pnpm-first',
      versions: [
        { hash: 'aaaaaaaa11111111', managedBy: 'gildeboek@v1', firstSeenAt: '2026-01-03T10:00:00.000Z', lastSeenAt: '2026-01-20T10:00:00.000Z', with: group(), without: thin },
        { hash: 'bbbbbbbb22222222', managedBy: null, firstSeenAt: '2026-02-01T10:00:00.000Z', lastSeenAt: '2026-02-02T10:00:00.000Z', with: thin, without: group({ n: 0, insufficient: true, rates: null, avgRevisionRounds: null, medianTokens: null, tokensN: 0 }) },
      ],
    },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'getSkillImpact').mockResolvedValue(impact);
});

describe('SkillImpactView', () => {
  it('shows the versions timeline, sample sizes and rates of a sufficient group', async () => {
    render(<SkillImpactView projectId="p1" />);
    const versions = await screen.findByRole('table', { name: 'pnpm-first versions' });
    const rows = within(versions).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('aaaaaaaa');
    expect(rows[1]).toHaveTextContent('2026-01-03');
    expect(rows[2]).toHaveTextContent('bbbbbbbb');
    expect(rows[2]).toHaveTextContent('repo-owned');

    const table = screen.getByRole('table', { name: 'pnpm-first aaaaaaaa with and without' });
    expect(within(table).getByText('n = 12')).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /^Done/ })).toHaveTextContent('9 (75%)');
    expect(within(table).getByRole('row', { name: /^Average revision rounds/ })).toHaveTextContent('1.50');
    expect(within(table).getByRole('row', { name: /^Median attributed tokens/ })).toHaveTextContent('123,456 (n = 10)');
  });

  it('shows "Not enough data" with counts and no rates for a thin group, and dashes for an empty one', async () => {
    render(<SkillImpactView projectId="p1" />);
    const table = await screen.findByRole('table', { name: 'pnpm-first aaaaaaaa with and without' });
    expect(within(table).getByText('Not enough data')).toBeInTheDocument();
    // The thin "without" group: 2 done, no percentage.
    expect(within(table).getByRole('row', { name: /^Done/ }).textContent).toMatch(/9 \(75%\).*2$/);
    const second = screen.getByRole('table', { name: 'pnpm-first bbbbbbbb with and without' });
    expect(within(second).getAllByText('Not enough data')).toHaveLength(2);
    expect(within(second).getByRole('row', { name: /^Done/ }).textContent).toMatch(/2–$/);
  });

  it('always states that the comparisons are descriptive and uses no causal or significance wording', async () => {
    const { container } = render(<SkillImpactView projectId="p1" />);
    await screen.findByRole('table', { name: 'pnpm-first versions' });
    expect(screen.getByText(IMPACT_NOTE)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/improv|significan|p-value|uplift|better than|because of/i);
  });

  it('explains the minimum sample size and refetches with the chosen window', async () => {
    render(<SkillImpactView projectId="p1" />);
    expect(await screen.findByText(/fewer than 10 finished runs/)).toBeInTheDocument();
    expect(api.getSkillImpact).toHaveBeenLastCalledWith('p1', 30);
    fireEvent.change(screen.getByLabelText('Window'), { target: { value: '90' } });
    await waitFor(() => expect(api.getSkillImpact).toHaveBeenLastCalledWith('p1', 90));
  });

  it('shows an empty state without skill data', async () => {
    vi.spyOn(api, 'getSkillImpact').mockResolvedValue({ days: 30, minRuns: 10, skills: [] });
    render(<SkillImpactView projectId="p1" />);
    expect(await screen.findByText('No skill data yet')).toBeInTheDocument();
  });

  it('shows the API error', async () => {
    vi.spyOn(api, 'getSkillImpact').mockRejectedValue(new ApiError('GET failed: 500', 500));
    render(<SkillImpactView projectId="p1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('GET failed: 500');
  });
});
