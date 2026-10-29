import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { runDetail, runSummary } from './agent.fixture';
import { ActivityTab } from './agent-activity-tab';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const page = (items = [runSummary()], total = items.length, p = 1) => ({ items, page: p, pageSize: 25, total });

beforeEach(() => {
  vi.spyOn(api, 'listProjects').mockResolvedValue([{ id: 'p1', name: 'Gilde' } as never]);
  vi.spyOn(api, 'listExecutors').mockResolvedValue([{ id: 'x1', name: 'My routine' } as never]);
});
afterEach(() => vi.restoreAllMocks());

describe('ActivityTab', () => {
  it('lists runs with their trigger link, outcome and project', async () => {
    vi.spyOn(api, 'listAgentRuns').mockResolvedValue(
      page([
        runSummary({ id: 'r1', triggerKind: 'dispatch', triggerRefType: 'job', triggerRefId: 'j1' }),
        runSummary({ id: 'r2', triggerKind: 'spec_version', triggerRefType: 'spec', triggerRefId: 's1', outcome: 'error' }),
        runSummary({ id: 'r3', triggerKind: 'intake_item', triggerRefType: 'intake_item', triggerRefId: 'i1', outcome: null }),
      ]),
    );
    render(<ActivityTab agent="werkmeester" project="p1" />);
    const table = within(await screen.findByRole('table'));
    expect(table.getByRole('link', { name: 'job' })).toHaveAttribute('href', '/jobs/j1?project=p1');
    expect(table.getByRole('link', { name: 'spec' })).toHaveAttribute('href', '/specs/s1?project=p1');
    expect(table.getByRole('link', { name: 'intake item' })).toHaveAttribute('href', '/intake?project=p1');
    expect(table.getByText('Error')).toBeInTheDocument();
    expect(table.getByText('Running')).toBeInTheDocument();
    expect(table.getAllByText('Gilde')).toHaveLength(3);
    expect(table.queryByText('Executor')).toBeNull();
  });

  it('filters by trigger, outcome, project and period and returns to page 1', async () => {
    const list = vi.spyOn(api, 'listAgentRuns').mockResolvedValue(page([runSummary()], 60));
    render(<ActivityTab agent="verfijner" project={null} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith('verfijner', expect.objectContaining({ page: 2, pageSize: 25 })));

    const filters = within(screen.getByRole('form', { name: 'Filters' }));
    fireEvent.change(filters.getByLabelText('Trigger'), { target: { value: 'signal' } });
    fireEvent.change(filters.getByLabelText('Outcome'), { target: { value: 'error' } });
    await waitFor(() => expect(screen.getByLabelText('Project')).toBeInTheDocument());
    await screen.findByRole('option', { name: 'Gilde' });
    fireEvent.change(filters.getByLabelText('Project'), { target: { value: 'p1' } });
    fireEvent.change(filters.getByLabelText('Period'), { target: { value: '7d' } });
    await waitFor(() => {
      const [agent, params] = list.mock.calls.at(-1)!;
      expect(agent).toBe('verfijner');
      expect(params).toMatchObject({ trigger: 'signal', outcome: 'error', projectId: 'p1', page: 1 });
      expect(Date.now() - new Date(params!.from!).getTime()).toBeGreaterThan(6.9 * 86400_000);
    });
  });

  it('pages through the runs', async () => {
    const list = vi.spyOn(api, 'listAgentRuns').mockImplementation(async (_a, p) => page([runSummary({ id: `r${p?.page}` })], 60, p?.page ?? 1));
    render(<ActivityTab agent="verfijner" project={null} />);
    expect(await screen.findByText('Page 1 of 3 · 60 runs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Page 2 of 3 · 60 runs')).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith('verfijner', expect.objectContaining({ page: 2 }));
  });

  it('expands a run into its tool calls and shows recorded content as escaped plain text', async () => {
    vi.spyOn(api, 'listAgentRuns').mockResolvedValue(page());
    const get = vi.spyOn(api, 'getAgentRun').mockResolvedValue(runDetail({ reason: '<b>why</b>' }));
    const { container } = render(<ActivityTab agent="verfijner" project={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /Details/ }));
    const calls = within(await screen.findByRole('list', { name: 'Tool calls' }));
    expect(get).toHaveBeenCalledWith('r1');
    expect(calls.getByText('listSpecs')).toBeInTheDocument();
    expect(calls.getByText('12 ms')).toBeInTheDocument();
    expect(calls.getByText('duration unknown')).toBeInTheDocument();
    expect(calls.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(calls.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(screen.getByText('<b>why</b>')).toBeInTheDocument();
    expect(container.querySelector('script, img, b')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Hide/ }));
    expect(screen.queryByRole('list', { name: 'Tool calls' })).toBeNull();
  });

  it('shows only metadata for another user\'s co-pilot run and never fetches its content', async () => {
    vi.spyOn(api, 'listAgentRuns').mockResolvedValue(
      page([runSummary({ id: 'c1', agentId: 'gilde', triggerKind: 'chat', triggerRefType: null, triggerRefId: null, reason: null, metadataOnly: true, toolCallCount: 3 })]),
    );
    const get = vi.spyOn(api, 'getAgentRun');
    render(<ActivityTab agent="gilde" project={null} />);
    const row = within(await screen.findByRole('row', { name: /Chat/ }));
    expect(row.getByText('Metadata only')).toBeInTheDocument();
    expect(row.queryByRole('link')).toBeNull();
    expect(row.queryByRole('button')).toBeNull();
    expect(row.getByText('3')).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it('shows the executor of coding runs and filters by it', async () => {
    const list = vi.spyOn(api, 'listAgentRuns').mockResolvedValue(
      page([runSummary({ agentId: 'coding', triggerKind: 'dispatch', triggerRefType: 'job', triggerRefId: 'j1', executor: { id: 'x1', name: 'My routine' } })]),
    );
    render(<ActivityTab agent="coding" project={null} />);
    const table = within(await screen.findByRole('table'));
    expect(table.getByText('Executor')).toBeInTheDocument();
    expect(table.getByText('My routine')).toBeInTheDocument();
    await screen.findByRole('option', { name: 'My routine' });
    fireEvent.change(screen.getByLabelText('Executor'), { target: { value: 'x1' } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith('coding', expect.objectContaining({ executorId: 'x1', page: 1 })));
  });

  it('says so when nothing matches', async () => {
    vi.spyOn(api, 'listAgentRuns').mockResolvedValue(page([], 0));
    render(<ActivityTab agent="verfijner" project={null} />);
    expect(await screen.findByText('No runs match.')).toBeInTheDocument();
  });

  it('shows the Slack bot\'s delivered notifications as text', async () => {
    const list = vi.spyOn(api, 'listSlackDeliveries').mockResolvedValue({
      items: [
        { id: 'd1', kind: 'job.parked', title: 'Parked <b>job</b>', projectId: 'p1', jobId: 'j1', status: 'delivered', attempts: 1, lastError: null, occurredAt: '2026-10-29T08:00:00.000Z', deliveredAt: '2026-10-29T08:01:00.000Z' },
        { id: 'd2', kind: 'budget.hard', title: 'Budget', projectId: null, jobId: null, status: 'failed', attempts: 3, lastError: 'channel_not_found', occurredAt: '2026-10-29T07:00:00.000Z', deliveredAt: null },
      ],
      page: 1, pageSize: 25, total: 2,
    });
    const { container } = render(<ActivityTab agent="slack" project={null} />);
    const table = within(await screen.findByRole('table'));
    expect(list).toHaveBeenCalledWith({ page: 1, pageSize: 25 });
    expect(table.getByText('Parked <b>job</b>')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
    expect(table.getByText('Delivered')).toBeInTheDocument();
    expect(table.getByText('Failed')).toBeInTheDocument();
    expect(table.getByText('channel_not_found')).toBeInTheDocument();
  });
});
