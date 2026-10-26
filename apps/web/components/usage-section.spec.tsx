import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Usage, type UsageTotals } from '@/lib/api';
import { UsageSection } from './usage-section';

const t = (over: Partial<UsageTotals>): UsageTotals => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costUsd: null, runs: 0, ...over });

const usage = (costUsd: number | null): Usage => ({
  days: 30,
  totals: t({ inputTokens: 1500, cachedInputTokens: 500, outputTokens: 500, totalTokens: 2000, costUsd, runs: 3 }),
  daily: [{ date: '2026-03-09', ...t({}) }, { date: '2026-03-10', ...t({ totalTokens: 2000, runs: 3, costUsd }) }],
  byModel: [{ model: 'openai/m1', ...t({ totalTokens: 2000, runs: 3, costUsd }) }],
  byKind: [{ kind: 'chat', ...t({ totalTokens: 2000, runs: 3 }) }],
  byUser: [{ userId: 'u1', userName: 'Ann', ...t({ totalTokens: 2000, runs: 3, costUsd }) }],
});

beforeEach(() => vi.restoreAllMocks());

describe('UsageSection', () => {
  it('shows tokens, cost, chart and per model / per user tables', async () => {
    vi.spyOn(api, 'getUsage').mockResolvedValue(usage(1.5));
    render(<UsageSection days={30} />);
    await waitFor(() => expect(screen.getByText('Total tokens')).toBeTruthy());
    expect(screen.getAllByText('2.0k').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$1.50').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: 'Tokens used per day' }).tagName.toLowerCase()).toBe('svg');
    expect(within(screen.getByRole('region', { name: 'Per model' })).getByText('openai/m1')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Per user' })).getByText('Ann')).toBeTruthy();
  });

  it('shows a dash when the cost is unknown', async () => {
    vi.spyOn(api, 'getUsage').mockResolvedValue(usage(null));
    render(<UsageSection days={30} />);
    await waitFor(() => expect(screen.getByText('Total tokens')).toBeTruthy());
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.getAllByText('–').length).toBeGreaterThanOrEqual(3);
  });

  it('shows an empty state', async () => {
    vi.spyOn(api, 'getUsage').mockResolvedValue({ ...usage(null), totals: t({}) });
    render(<UsageSection days={30} />);
    await waitFor(() => expect(screen.getByText(/No LLM usage/)).toBeTruthy());
  });
});
