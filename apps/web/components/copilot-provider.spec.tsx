import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pathname = vi.hoisted(() => ({ value: '/' }));
const status = vi.hoisted(() => vi.fn());
const readable = vi.hoisted(() => vi.fn());
const getBudget = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({ usePathname: () => pathname.value }));
vi.mock('@/lib/api', () => ({ api: { copilotStatus: status, getBudget } }));
vi.mock('@copilotkit/react-ui/styles.css', () => ({}));
vi.mock('@copilotkit/react-core', () => ({
  CopilotKit: ({ children, ...props }: { children: React.ReactNode; runtimeUrl: string; agent: string }) => (
    <div data-testid="copilotkit" data-runtime={props.runtimeUrl} data-agent={props.agent}>{children}</div>
  ),
  useCopilotReadable: readable,
}));
vi.mock('@copilotkit/react-core/v2/headless', () => ({ useInterrupt: vi.fn() }));
vi.mock('@copilotkit/react-ui', () => ({
  CopilotSidebar: ({ children, defaultOpen, labels }: { children: React.ReactNode; defaultOpen: boolean; labels: { title: string } }) => (
    <aside data-testid="sidebar" data-open={String(defaultOpen)} data-title={labels.title}>{children}</aside>
  ),
}));
vi.mock('@/components/copilot-tool-renderers', () => ({
  CopilotToolRenderers: () => null,
  CopilotBusyIndicator: () => null,
  GroupedMessage: () => null,
}));

import { CopilotPageContext, CopilotProvider } from './copilot-provider';
import type { BudgetPeriodStatus, BudgetStatus } from '@/lib/api';

const period = (p: 'day' | 'week', over: Partial<BudgetPeriodStatus> = {}): BudgetPeriodStatus => ({
  scope: 'global', period: p, projectId: null, startsAt: '2026-03-09T00:00:00.000Z', resetsAt: '2026-03-10T00:00:00.000Z',
  spent: 1, pricedRows: 1, totalRows: 1, unpricedRows: 0, pricing: 'complete', incomplete: false,
  limit: null, percent: null, softPct: 80, state: 'ok', reason: null, ...over,
});
const budgetStatus = (day: Partial<BudgetPeriodStatus> = {}, week: Partial<BudgetPeriodStatus> = {}, over: Partial<BudgetStatus> = {}): BudgetStatus => ({
  evaluatedAt: '2026-03-09T12:00:00.000Z', global: { day: period('day', day), week: period('week', week) }, project: null,
  blockers: [], hardBlocked: false, recovery: 'none', recoversAt: null, ...over,
});
const enabledStatus = { enabled: true, model: 'openai/m', scout: { enabled: false, model: null }, refine: { enabled: false, model: null } };

beforeEach(() => {
  pathname.value = '/';
  status.mockReset();
  readable.mockReset();
  getBudget.mockReset().mockResolvedValue(budgetStatus());
});

describe('CopilotProvider', () => {
  it('wraps the app with a collapsed sidebar through the proxy when the co-pilot is enabled', async () => {
    status.mockResolvedValue({ enabled: true, model: 'openai/m', scout: { enabled: false, model: null, scout: { enabled: false, model: null } } });
    render(<CopilotProvider><p>app</p></CopilotProvider>);
    const sidebar = await screen.findByTestId('sidebar');
    expect(sidebar).toHaveAttribute('data-open', 'false');
    expect(sidebar).toHaveAttribute('data-title', 'Gilde co-pilot');
    expect(screen.getByTestId('copilotkit')).toHaveAttribute('data-runtime', '/api/gilde/v1/mastra/copilotkit');
    expect(screen.getByTestId('copilotkit')).toHaveAttribute('data-agent', 'gilde');
    expect(screen.getByText('app')).toBeInTheDocument();
  });

  it('shows a not-configured note instead of the sidebar when disabled', async () => {
    status.mockResolvedValue({ enabled: false, model: null, scout: { enabled: false, model: null } });
    render(<CopilotProvider><p>app</p></CopilotProvider>);
    expect(await screen.findByText('Co-pilot not configured')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument();
    expect(screen.getByText('app')).toBeInTheDocument();
  });

  it('renders no sidebar on /chat, where the full-page chat is the one chat', async () => {
    pathname.value = '/chat';
    status.mockResolvedValue(enabledStatus);
    render(<CopilotProvider><p>chat page</p></CopilotProvider>);
    expect(await screen.findByTestId('copilotkit')).toBeInTheDocument();
    expect(screen.getByText('chat page')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument();
  });

  it('treats a failing status call as not configured', async () => {
    status.mockRejectedValue(new Error('down'));
    render(<CopilotProvider><p>app</p></CopilotProvider>);
    expect(await screen.findByText('Co-pilot not configured')).toBeInTheDocument();
  });

  it('renders nothing extra on /login and does not ask for the status', async () => {
    pathname.value = '/login';
    render(<CopilotProvider><p>login</p></CopilotProvider>);
    expect(screen.getByText('login')).toBeInTheDocument();
    await waitFor(() => expect(status).not.toHaveBeenCalled());
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument();
    expect(screen.queryByText('Co-pilot not configured')).not.toBeInTheDocument();
  });

  it('shares page context with the co-pilot only while it is enabled', async () => {
    status.mockResolvedValue({ enabled: true, model: 'openai/m', scout: { enabled: false, model: null, scout: { enabled: false, model: null } } });
    render(
      <CopilotProvider>
        <CopilotPageContext description="The project selected in the Gilde UI" value={{ projectId: 'p1' }} />
      </CopilotProvider>,
    );
    await screen.findByTestId('sidebar');
    expect(readable).toHaveBeenCalledWith({ description: 'The project selected in the Gilde UI', value: { projectId: 'p1' } });
  });

  it('page context is a no-op without the provider', () => {
    render(<CopilotPageContext description="x" value={1} />);
    expect(readable).not.toHaveBeenCalled();
  });

  describe('global budget warning', () => {
    it('shows nothing while every global period is ok', async () => {
      status.mockResolvedValue(enabledStatus);
      render(<CopilotProvider><p>app</p></CopilotProvider>);
      await screen.findByTestId('sidebar');
      await waitFor(() => expect(getBudget).toHaveBeenCalled());
      expect(screen.queryByLabelText('Global budget')).not.toBeInTheDocument();
    });

    it('warns at soft with estimated spend, state and reset, and says the co-pilot stays available', async () => {
      getBudget.mockResolvedValue(budgetStatus({ state: 'soft', limit: 10, spent: 8.1, percent: 81.2 }));
      status.mockResolvedValue(enabledStatus);
      render(<CopilotProvider><p>app</p></CopilotProvider>);
      const warning = await screen.findByLabelText('Global budget');
      expect(warning).toHaveTextContent('Global estimated budget warning');
      expect(warning).toHaveTextContent('Daily: $8.10 of $10.00 estimated (81%), resets 2026-03-10 00:00 UTC');
      expect(warning).toHaveTextContent('co-pilot and the rest of Gilde stay available');
      expect(warning).not.toHaveTextContent('automatic dispatch is stopped');
    });

    it('at hard names the stop and the latest reset, and chat stays usable (sidebar mounted, nothing disabled)', async () => {
      getBudget.mockResolvedValue(budgetStatus(
        { state: 'hard', limit: 10, spent: 12, percent: 120 },
        { state: 'hard', limit: 50, spent: 60, percent: 120, resetsAt: '2026-03-16T00:00:00.000Z' },
        { hardBlocked: true, recovery: 'reset', recoversAt: '2026-03-16T00:00:00.000Z' },
      ));
      status.mockResolvedValue(enabledStatus);
      render(<CopilotProvider><p>app</p></CopilotProvider>);
      const warning = await screen.findByLabelText('Global budget');
      expect(warning).toHaveTextContent('Global estimated budget reached');
      expect(warning).toHaveTextContent('Weekly: $60.00 of $50.00 estimated (120%)');
      expect(warning).toHaveTextContent('New automatic dispatch is stopped until 2026-03-16 00:00 UTC at the earliest');
      expect(warning).toHaveTextContent('co-pilot and the rest of Gilde stay available');
      expect(screen.getByTestId('sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('copilotkit')).toBeInTheDocument();
      expect(screen.getByText('app')).toBeInTheDocument();
      expect(warning).toHaveClass('text-danger');
    });

    it('explains an invalid global configuration without a reset promise', async () => {
      getBudget.mockResolvedValue(budgetStatus(
        { state: 'hard', reason: { kind: 'configError', variable: 'GLOBAL_DAILY_BUDGET_USD', message: 'x' } },
        {}, { hardBlocked: true, recovery: 'manual', recoversAt: null },
      ));
      status.mockResolvedValue(enabledStatus);
      render(<CopilotProvider><p>app</p></CopilotProvider>);
      const warning = await screen.findByLabelText('Global budget');
      expect(warning).toHaveTextContent('GLOBAL_DAILY_BUDGET_USD is invalid');
      expect(warning).toHaveTextContent('until the limit or configuration changes');
    });

    it('keeps chat working and shows nothing when the budget lookup fails', async () => {
      getBudget.mockRejectedValue(new Error('down'));
      status.mockResolvedValue(enabledStatus);
      render(<CopilotProvider><p>app</p></CopilotProvider>);
      expect(await screen.findByTestId('sidebar')).toBeInTheDocument();
      await waitFor(() => expect(getBudget).toHaveBeenCalled());
      expect(screen.queryByLabelText('Global budget')).not.toBeInTheDocument();
    });

    it('does not poll the budget on /login', async () => {
      pathname.value = '/login';
      render(<CopilotProvider><p>login</p></CopilotProvider>);
      await waitFor(() => expect(status).not.toHaveBeenCalled());
      expect(getBudget).not.toHaveBeenCalled();
    });

    it('also warns when the co-pilot itself is not configured', async () => {
      getBudget.mockResolvedValue(budgetStatus({ state: 'soft', limit: 10, spent: 9, percent: 90 }));
      status.mockResolvedValue({ enabled: false, model: null, scout: { enabled: false, model: null } });
      render(<CopilotProvider><p>app</p></CopilotProvider>);
      expect(await screen.findByLabelText('Global budget')).toBeInTheDocument();
    });
  });
});
