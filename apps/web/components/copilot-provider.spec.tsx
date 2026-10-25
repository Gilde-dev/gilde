import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pathname = vi.hoisted(() => ({ value: '/' }));
const status = vi.hoisted(() => vi.fn());
const readable = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({ usePathname: () => pathname.value }));
vi.mock('@/lib/api', () => ({ api: { copilotStatus: status } }));
vi.mock('@copilotkit/react-ui/styles.css', () => ({}));
vi.mock('@copilotkit/react-core', () => ({
  CopilotKit: ({ children, ...props }: { children: React.ReactNode; runtimeUrl: string; agent: string }) => (
    <div data-testid="copilotkit" data-runtime={props.runtimeUrl} data-agent={props.agent}>{children}</div>
  ),
  useCopilotReadable: readable,
}));
vi.mock('@copilotkit/react-ui', () => ({
  CopilotSidebar: ({ children, defaultOpen, labels }: { children: React.ReactNode; defaultOpen: boolean; labels: { title: string } }) => (
    <aside data-testid="sidebar" data-open={String(defaultOpen)} data-title={labels.title}>{children}</aside>
  ),
}));

import { CopilotPageContext, CopilotProvider } from './copilot-provider';

beforeEach(() => {
  pathname.value = '/';
  status.mockReset();
  readable.mockReset();
});

describe('CopilotProvider', () => {
  it('wraps the app with a collapsed sidebar through the proxy when the co-pilot is enabled', async () => {
    status.mockResolvedValue({ enabled: true, model: 'openai/m' });
    render(<CopilotProvider><p>app</p></CopilotProvider>);
    const sidebar = await screen.findByTestId('sidebar');
    expect(sidebar).toHaveAttribute('data-open', 'false');
    expect(sidebar).toHaveAttribute('data-title', 'Gilde co-pilot');
    expect(screen.getByTestId('copilotkit')).toHaveAttribute('data-runtime', '/api/gilde/v1/mastra/copilotkit');
    expect(screen.getByTestId('copilotkit')).toHaveAttribute('data-agent', 'gilde');
    expect(screen.getByText('app')).toBeInTheDocument();
  });

  it('shows a not-configured note instead of the sidebar when disabled', async () => {
    status.mockResolvedValue({ enabled: false, model: null });
    render(<CopilotProvider><p>app</p></CopilotProvider>);
    expect(await screen.findByText('Co-pilot not configured')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument();
    expect(screen.getByText('app')).toBeInTheDocument();
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
    status.mockResolvedValue({ enabled: true, model: 'openai/m' });
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
});
