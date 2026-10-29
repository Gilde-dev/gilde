import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '@/lib/api';
import { agent, slackBot } from './agent.fixture';
import { AgentsView } from './agents-view';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('project=p1'),
  usePathname: () => '/agents',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => vi.restoreAllMocks());

const runs = (total: number, items: { id: string; triggerKind: string; outcome: 'ok' | 'error' | null; startedAt: string }[] = []) => ({ items, page: 1, pageSize: 1, total });

describe('AgentsView', () => {
  it('lists every agent and the Slack bot with status, reason, bot user, model, usage, limits, trigger and last run', async () => {
    vi.spyOn(api, 'listAgents').mockResolvedValue([
      agent(),
      agent({ id: 'verkenner', label: 'Verkenner', status: 'misconfigured', reason: 'ops@x.test is not marked as a bot', settings: { dailyLimit: 3, summaryHourUtc: 7 }, effectiveModel: null, hasModel: true }),
      agent({ id: 'coding', label: 'Coding agents', hasBotUser: false, botUser: null, hasModel: false, model: null, effectiveModel: null }),
      agent({ id: 'mcp', label: 'MCP server', status: 'disabled_by_env', reason: 'MCP_ENABLED is not "true"', hasBotUser: false, botUser: null }),
      agent({ id: 'werkmeester', label: 'Werkmeester', status: 'off' }),
    ]);
    vi.spyOn(api, 'getSlackBot').mockResolvedValue(slackBot());
    vi.spyOn(api, 'listAgentRuns').mockImplementation(async (_id, p) =>
      p?.from ? runs(4) : runs(9, [{ id: 'r1', triggerKind: 'intake_item', outcome: 'ok', startedAt: new Date(Date.now() - 3_600_000).toISOString() }]),
    );
    render(<AgentsView />);

    const refiner = within(await screen.findByRole('article', { name: 'Verfijner' }));
    expect(refiner.getByText('On')).toBeInTheDocument();
    expect(refiner.getByText('refiner@bots.test')).toBeInTheDocument();
    expect(refiner.getByText('openai/gpt-5-mini')).toBeInTheDocument();
    expect(refiner.getByText('4 runs today')).toBeInTheDocument();
    expect(refiner.getByText('Runs per project per day: 10')).toBeInTheDocument();
    expect(refiner.getByText('Labelled GitHub issues (intake items)')).toBeInTheDocument();
    expect(refiner.getByText('ok')).toBeInTheDocument();
    expect(refiner.getByText('1 hour ago')).toBeInTheDocument();
    expect(refiner.getByRole('link', { name: 'Verfijner' })).toHaveAttribute('href', '/agents/verfijner?project=p1');

    const scout = within(screen.getByRole('article', { name: 'Verkenner' }));
    expect(scout.getByText('Misconfigured')).toBeInTheDocument();
    expect(scout.getByText('ops@x.test is not marked as a bot')).toBeInTheDocument();
    expect(scout.getByText(/daily summary at 07:00 UTC/)).toBeInTheDocument();

    expect(within(screen.getByRole('article', { name: 'MCP server' })).getByText('Disabled by the environment')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Werkmeester' })).getByText('Off')).toBeInTheDocument();

    const slack = within(screen.getByRole('article', { name: 'Slack bot' }));
    expect(slack.getByText('On')).toBeInTheDocument();
    expect(slack.getByText('slacky@bots.test')).toBeInTheDocument();
    expect(slack.getByRole('link', { name: 'Slack bot' })).toHaveAttribute('href', '/agents/slack?project=p1');
  });

  it('shows the last run and usage empty, without failing, when the run log is not available', async () => {
    vi.spyOn(api, 'listAgents').mockResolvedValue([agent()]);
    vi.spyOn(api, 'getSlackBot').mockRejectedValue(new ApiError('x', 500));
    vi.spyOn(api, 'listAgentRuns').mockRejectedValue(new ApiError('x', 404));
    render(<AgentsView />);
    const refiner = within(await screen.findByRole('article', { name: 'Verfijner' }));
    expect(refiner.getAllByText('Not available')).toHaveLength(2);
    expect(within(screen.getByRole('article', { name: 'Slack bot' })).getByText('Unknown')).toBeInTheDocument();
  });

  it('says "No runs yet" for an agent that never ran', async () => {
    vi.spyOn(api, 'listAgents').mockResolvedValue([agent()]);
    vi.spyOn(api, 'getSlackBot').mockResolvedValue(slackBot());
    vi.spyOn(api, 'listAgentRuns').mockResolvedValue(runs(0));
    render(<AgentsView />);
    expect(await screen.findByText('0 runs today')).toBeInTheDocument();
    expect(screen.getByText('No runs yet')).toBeInTheDocument();
  });

  it('shows a loading state, then an error with retry that loads the list', async () => {
    const list = vi.spyOn(api, 'listAgents').mockRejectedValueOnce(new ApiError('boom', 500, 'Database is down'));
    vi.spyOn(api, 'getSlackBot').mockResolvedValue(slackBot());
    vi.spyOn(api, 'listAgentRuns').mockResolvedValue(runs(0));
    render(<AgentsView />);
    expect(screen.getByRole('status', { name: 'Loading agents' })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Database is down');
    list.mockResolvedValue([agent()]);
    screen.getByRole('button', { name: 'Retry' }).click();
    await waitFor(() => expect(screen.getByRole('article', { name: 'Verfijner' })).toBeInTheDocument());
  });
});
