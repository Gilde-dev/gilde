import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type McpAuditEntry, type McpServer, type McpServerDetail, type McpTool } from '@/lib/api';
import { McpServersTab } from './mcp-servers-tab';

const server: McpServer = {
  id: 's1', projectId: 'p1', name: 'notion', url: 'https://mcp.example.com/mcp', hasToken: true, tokenLast4: '1234',
  enabled: true, unattendedEnabled: false, lastTestedAt: null, lastError: 'Timed out after 5s', lastErrorAt: '2026-10-29T10:00:00Z',
  callCount: 12, errorCount: 3, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
};
const search: McpTool = { name: 'search', description: 'Search pages', mode: 'read', allowed: false };
const update: McpTool = { name: 'update_page', description: 'Edit a page', mode: 'write', allowed: false };
const auditEntry: McpAuditEntry = {
  id: 'a1', serverId: 's1', serverName: 'notion', actorId: 'u1', actorEmail: 'pascal@example.com', action: 'created', changes: {},
  createdAt: '2026-10-01T00:00:00Z',
};
const detail = (tools: McpTool[] = [], audit: McpAuditEntry[] = []): McpServerDetail => ({ ...server, tools, audit });

beforeEach(() => {
  vi.spyOn(api, 'listMcpServers').mockResolvedValue([server]);
  vi.spyOn(api, 'getMcpServer').mockResolvedValue(detail());
});
afterEach(() => vi.restoreAllMocks());

const card = async () => within(await screen.findByRole('article', { name: 'notion' }));

describe('McpServersTab', () => {
  it('lists servers with a masked token, usage and the last error', async () => {
    render(<McpServersTab projectId="p1" />);
    const c = await card();
    expect(c.getByText('https://mcp.example.com/mcp')).toBeInTheDocument();
    expect(c.getByText('••••1234')).toBeInTheDocument();
    expect(c.getByText('12 calls, 3 errors')).toBeInTheDocument();
    expect(c.getByText('Timed out after 5s')).toBeInTheDocument();
    expect(c.getByText('Unattended agents: no')).toBeInTheDocument();
    expect(c.getByText('Enabled')).toBeInTheDocument();
  });

  it('shows loading, empty and error states', async () => {
    vi.mocked(api.listMcpServers).mockReturnValueOnce(new Promise(() => {}));
    const { unmount } = render(<McpServersTab projectId="p1" />);
    expect(screen.getByRole('status', { name: 'Loading MCP servers' })).toBeInTheDocument();
    unmount();

    vi.mocked(api.listMcpServers).mockResolvedValueOnce([]);
    const empty = render(<McpServersTab projectId="p1" />);
    expect(await screen.findByText('No MCP servers yet')).toBeInTheDocument();
    empty.unmount();

    vi.mocked(api.listMcpServers).mockRejectedValueOnce(new ApiError('boom', 500, 'Database is down'));
    render(<McpServersTab projectId="p1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Database is down');
  });

  it('explains a 503 (no key on the server)', async () => {
    vi.mocked(api.listMcpServers).mockRejectedValueOnce(new ApiError('x', 503, 'not configured'));
    render(<McpServersTab projectId="p1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('EXECUTOR_SECRET_KEY');
  });

  it('adds a server with the token from the form', async () => {
    const create = vi.spyOn(api, 'createMcpServer').mockResolvedValue(server);
    vi.mocked(api.listMcpServers).mockResolvedValue([]);
    render(<McpServersTab projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' notion ' } });
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://mcp.example.com/mcp' } });
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'secret-token' } });
    fireEvent.click(screen.getByLabelText(/Available to unattended agents/));
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith('p1', {
        name: 'notion', url: 'https://mcp.example.com/mcp', token: 'secret-token', enabled: true, unattendedEnabled: true,
      }),
    );
  });

  it('shows zod issues and 403 for a refused write', async () => {
    vi.spyOn(api, 'createMcpServer').mockRejectedValueOnce(new ApiError('x', 400, 'bad', [{ path: 'url', message: 'Must be a public https URL' }]));
    vi.mocked(api.listMcpServers).mockResolvedValue([]);
    render(<McpServersTab projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'n' } });
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'http://x' } });
    fireEvent.submit(screen.getByLabelText('Name').closest('form')!);
    expect(await screen.findByText('Must be a public https URL')).toBeInTheDocument();

    vi.spyOn(api, 'createMcpServer').mockRejectedValueOnce(new ApiError('x', 403, 'Forbidden'));
    fireEvent.submit(screen.getByLabelText('Name').closest('form')!);
    expect(await screen.findByText(/Only a signed-in person can/)).toBeInTheDocument();
  });

  it('edits with a full PUT built from the latest loaded server', async () => {
    const replace = vi.spyOn(api, 'replaceMcpServer').mockResolvedValue(server);
    render(<McpServersTab projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit notion' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'wiki' } });
    fireEvent.click(screen.getByLabelText(/Available to unattended agents/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith('p1', 's1', { name: 'wiki', url: 'https://mcp.example.com/mcp', enabled: true, unattendedEnabled: true }),
    );
  });

  it('toggles enabled with a full PUT', async () => {
    const replace = vi.spyOn(api, 'replaceMcpServer').mockResolvedValue(server);
    render(<McpServersTab projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable notion' }));
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith('p1', 's1', { name: 'notion', url: 'https://mcp.example.com/mcp', enabled: false, unattendedEnabled: false }),
    );
  });

  it('replaces the token without ever displaying it', async () => {
    const replaceToken = vi.spyOn(api, 'replaceMcpServerToken').mockResolvedValue(undefined);
    render(<McpServersTab projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Replace token of notion' }));
    const input = screen.getByLabelText('New token') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'brand-new-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace token' }));
    await waitFor(() => expect(replaceToken).toHaveBeenCalledWith('p1', 's1', 'brand-new-secret'));
    await waitFor(() => expect(screen.queryByLabelText('New token')).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain('brand-new-secret');
  });

  it('tests the connection and lists tools with modes defaulting from the server and an Allowed checkbox', async () => {
    vi.spyOn(api, 'testMcpServer').mockResolvedValue({ ok: true, errorKind: null, message: null, tools: [search, update] });
    vi.mocked(api.getMcpServer).mockResolvedValue(detail([search, update]));
    render(<McpServersTab projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tools and audit of notion' }));
    expect(screen.getByText(/Nothing is usable until it is allowed/)).toHaveTextContent(/never for unattended agents/);
    fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Search pages')).toBeInTheDocument();
    expect(screen.getByText('Edit a page')).toBeInTheDocument();
    expect(screen.getByLabelText('Mode of search')).toHaveValue('read');
    expect(screen.getByLabelText('Mode of update_page')).toHaveValue('write');
    expect(screen.getByLabelText('Allow search')).not.toBeChecked();
  });

  it('shows a failed test with its kind and message', async () => {
    vi.spyOn(api, 'testMcpServer').mockResolvedValue({ ok: false, errorKind: 'auth', message: 'The server rejected the token', tools: [] });
    render(<McpServersTab projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tools and audit of notion' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Authentication failed: The server rejected the token')).toBeInTheDocument();
  });

  it('saves the allowlist with the chosen modes', async () => {
    const save = vi.spyOn(api, 'replaceMcpServerTools').mockResolvedValue([{ ...search, allowed: true }, update]);
    vi.mocked(api.getMcpServer).mockResolvedValue(detail([search, update]));
    render(<McpServersTab projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tools and audit of notion' }));
    fireEvent.click(await screen.findByLabelText('Allow search'));
    fireEvent.change(screen.getByLabelText('Mode of update_page'), { target: { value: 'read' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save allowlist' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('p1', 's1', [
        { name: 'search', mode: 'read', allowed: true },
        { name: 'update_page', mode: 'read', allowed: false },
      ]),
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('shows the audit list', async () => {
    vi.mocked(api.getMcpServer).mockResolvedValue(detail([], [auditEntry]));
    render(<McpServersTab projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tools and audit of notion' }));
    const audit = await screen.findByRole('region', { name: 'Audit of notion' });
    expect(within(audit).getByText('Created')).toBeInTheDocument();
    expect(audit).toHaveTextContent('pascal@example.com');
  });

  it('deletes only after confirmation', async () => {
    const del = vi.spyOn(api, 'deleteMcpServer').mockResolvedValue(undefined);
    render(<McpServersTab projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete notion' }));
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete notion' }));
    expect(await screen.findByText('Delete notion?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('p1', 's1'));
  });
});
