import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Usage, type UsageTotals } from '@/lib/api';
import { agentTotals, agentUsage, noAgentUsage } from './agent-usage.fixture';
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

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'getAgentUsage').mockResolvedValue(agentUsage());
});

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

const A = agentTotals({ uncachedInputTokens: 1000, cachedInputTokens: 5000, cacheCreationTokens: 2000, outputTokens: 500, runs: 4, costUsd: 1.25 });
const U = agentTotals({ uncachedInputTokens: 100, cachedInputTokens: 400, cacheCreationTokens: 0, outputTokens: 100, runs: 1, costUsd: null, costUnknownRequests: 1 });

describe('Agents (Claude Code) section', () => {
  it('shows co-pilot and agent usage independently with honest scopes', async () => {
    vi.spyOn(api, 'getUsage').mockResolvedValue(usage(1.5));
    vi.spyOn(api, 'getAgentUsage').mockResolvedValue(
      agentUsage({
        scope: 'project',
        projectId: 'p1',
        totals: A,
        daily: [{ date: '2026-03-09', ...noAgentUsage }, { date: '2026-03-10', ...A }],
        byModel: [{ model: 'claude-x', ...A }],
        byRepo: [{ repoId: 'r1', fullName: 'o/repo', ...A }],
        byFeature: [{ featureId: 'f1', title: 'Checkout', ...A }],
      }),
    );
    render(<UsageSection days={30} projectId="p1" projectName="Shop" />);
    const agents = await screen.findByRole('region', { name: 'Agents (Claude Code)' });
    await within(agents).findByText('Estimated cost (USD)');
    expect(agents).toHaveTextContent('Uncached input');
    expect(agents).toHaveTextContent('Cache read');
    expect(agents).toHaveTextContent('Cache creation');
    expect(agents).toHaveTextContent('Output');
    expect(agents).toHaveTextContent('8.5k'); // total tokens
    expect(agents).toHaveTextContent('$1.25');
    expect(agents).toHaveTextContent('Requests');
    expect(agents).toHaveTextContent(/Usage of runs in Shop/);
    expect(agents).toHaveTextContent(/notional/);
    expect(within(agents).getByRole('region', { name: 'Agents Per model' })).toHaveTextContent('claude-x');
    expect(within(agents).getByRole('region', { name: 'Agents Per repo' })).toHaveTextContent('o/repo');
    expect(within(agents).getByRole('region', { name: 'Agents Per feature' })).toHaveTextContent('Checkout');
    expect(within(agents).getByRole('img', { name: /with estimated cost/ })).toBeTruthy();
    expect(agents.querySelector('title')?.textContent).toMatch(/estimated cost/);
    expect(api.getAgentUsage).toHaveBeenCalledWith(30, 'p1');
    // co-pilot stays global and independent
    const copilot = screen.getByRole('region', { name: 'Usage' });
    expect(copilot).toHaveTextContent('Co-pilot usage');
    expect(copilot).toHaveTextContent(/across all projects/);
  });

  it('switches to the all-projects view and shows the unattributed share', async () => {
    vi.spyOn(api, 'getUsage').mockResolvedValue(usage(null));
    const spy = vi.spyOn(api, 'getAgentUsage').mockImplementation(async (_d, projectId) =>
      projectId ? agentUsage({ scope: 'project', projectId, totals: A }) : agentUsage({ totals: agentTotals({ ...A, runs: 5, outputTokens: 600, cacheCreationTokens: 2000 }), unattributed: U }),
    );
    render(<UsageSection days={30} projectId="p1" projectName="Shop" />);
    await screen.findByText(/Usage of runs in Shop/);
    expect(screen.getByText('n/a')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'All projects + unattributed' }));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(30, undefined));
    const agents = screen.getByRole('region', { name: 'Agents (Claude Code)' });
    await within(agents).findByText(/including usage not matched to a run/);
    expect(agents).toHaveTextContent('7.0%'); // unattributed tokens / all tokens: 600 of 8,600
    expect(agents).toHaveTextContent('600 of 8.6k tokens');
  });

  it('distinguishes no telemetry, loading and error from real zeros', async () => {
    vi.spyOn(api, 'getUsage').mockResolvedValue(usage(null));
    const spy = vi.spyOn(api, 'getAgentUsage').mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<UsageSection days={30} projectId={null} />);
    expect(await within(screen.getByRole('region', { name: 'Agents (Claude Code)' })).findByText('Loading…')).toBeTruthy();
    unmount();

    spy.mockRejectedValue(new Error('agents down'));
    const second = render(<UsageSection days={30} projectId={null} />);
    expect(await screen.findByText('agents down')).toBeTruthy();
    second.unmount();

    spy.mockResolvedValue(agentUsage());
    render(<UsageSection days={30} projectId={null} />);
    expect(await screen.findByText(/No Claude Code telemetry received in the last 30 days/)).toBeTruthy();
  });

  it('shows unavailable (not $0) for unknown cost, a partial marker, and a 0% share with zero tokens', async () => {
    vi.spyOn(api, 'getUsage').mockResolvedValue(usage(null));
    vi.spyOn(api, 'getAgentUsage').mockResolvedValue(
      agentUsage({ totals: agentTotals({ ...A, costUsd: 0.5, costPartial: true, costUnknownRequests: 2 }), byModel: [{ model: 'm-unknown', ...U }], unattributed: noAgentUsage }),
    );
    render(<UsageSection days={30} projectId={null} />);
    const agents = await screen.findByRole('region', { name: 'Agents (Claude Code)' });
    await within(agents).findByText('Estimated cost (USD)');
    expect(agents).toHaveTextContent('$0.5000+ (2 requests unknown)');
    expect(within(agents).getByRole('region', { name: 'Agents Per model' })).toHaveTextContent('unavailable');
    expect(agents).toHaveTextContent('0.0%');
  });

  it('shows an unattributed-only dataset in the global view as a 100% share', async () => {
    vi.spyOn(api, 'getUsage').mockResolvedValue(usage(null));
    vi.spyOn(api, 'getAgentUsage').mockResolvedValue(agentUsage({ totals: U, unattributed: U }));
    render(<UsageSection days={30} projectId={null} />);
    expect(await screen.findByText('100%')).toBeTruthy();
  });
});
