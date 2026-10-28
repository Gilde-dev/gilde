import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Executor, type Project, type Repo } from '@/lib/api';
import { ExecutorsView } from './executors-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/settings/executors',
  useSearchParams: () => new URLSearchParams('project=p1'),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/abc/fire';
const executor = (over: Partial<Executor> = {}): Executor => ({
  id: 'e1', ownerId: 'u1', name: 'Pascal laptop', kind: 'routine', fireUrl: FIRE, hasToken: true, tokenLast4: '1234',
  repoIds: ['r1'], maxConcurrent: 2, dailyRunLimit: 10, enabled: true, exhaustedUntil: null,
  createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', ...over,
});

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(api, 'listProjects').mockResolvedValue([{ id: 'p1', name: 'Shop', slug: 'shop' } as Project]);
  vi.spyOn(api, 'listRepos').mockResolvedValue([
    { id: 'r1', fullName: 'o/api' } as Repo,
    { id: 'r2', fullName: 'o/web' } as Repo,
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe('ExecutorsView', () => {
  it('lists executors with a masked token, mono URL, repos and limits, and explains ownership', async () => {
    vi.spyOn(api, 'listExecutors').mockResolvedValue([executor({ exhaustedUntil: '2999-01-01T00:00:00.000Z' })]);
    render(<ExecutorsView />);
    expect(await screen.findByText('Pascal laptop')).toBeInTheDocument();
    expect(screen.getByText('••••1234')).toBeInTheDocument();
    expect(screen.getByText(FIRE)).toHaveClass('font-mono');
    expect(await screen.findByText('o/api')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText(/Exhausted until/)).toBeInTheDocument();
    expect(screen.getByText(/only run on your own executors/)).toBeInTheDocument();
  });

  it('lets the owner clear an active exhaustion, and offers nothing when the time has passed', async () => {
    const list = vi.spyOn(api, 'listExecutors').mockResolvedValue([executor({ exhaustedUntil: '2999-01-01T00:00:00.000Z' })]);
    const reset = vi.spyOn(api, 'resetExecutorExhaustion').mockResolvedValue(executor());
    render(<ExecutorsView />);
    list.mockResolvedValue([executor()]);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear exhaustion of Pascal laptop' }));
    await waitFor(() => expect(reset).toHaveBeenCalledWith('e1'));
    await waitFor(() => expect(screen.queryByText(/Exhausted until/)).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Clear exhaustion/ })).not.toBeInTheDocument();
  });

  it('does not show an exhaustion whose reset time has passed', async () => {
    vi.spyOn(api, 'listExecutors').mockResolvedValue([executor({ exhaustedUntil: '2000-01-01T00:00:00.000Z' })]);
    render(<ExecutorsView />);
    expect(await screen.findByText('Pascal laptop')).toBeInTheDocument();
    expect(screen.queryByText(/Exhausted until/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Clear exhaustion/ })).not.toBeInTheDocument();
  });

  it('shows a loading skeleton, then an empty state with an Add action', async () => {
    vi.spyOn(api, 'listExecutors').mockResolvedValue([]);
    render(<ExecutorsView />);
    expect(screen.getByRole('status', { name: 'Loading executors' })).toBeInTheDocument();
    expect(await screen.findByText('No executors yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add executor' })).toBeInTheDocument();
  });

  it('shows an error with retry', async () => {
    const list = vi.spyOn(api, 'listExecutors').mockRejectedValueOnce(new ApiError('boom', 500, 'boom')).mockResolvedValue([]);
    render(<ExecutorsView />);
    expect(await screen.findByText('boom')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No executors yet')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('says executors are not configured on a 503', async () => {
    vi.spyOn(api, 'listExecutors').mockRejectedValue(new ApiError('x', 503, 'Executors are not configured'));
    render(<ExecutorsView />);
    expect(await screen.findByText(/EXECUTOR_SECRET_KEY/)).toBeInTheDocument();
    expect(screen.getByText(/not configured on the server/)).toBeInTheDocument();
  });

  it('creates an executor from a password field and clears it', async () => {
    vi.spyOn(api, 'listExecutors').mockResolvedValue([]);
    const create = vi.spyOn(api, 'createExecutor').mockResolvedValue(executor());
    render(<ExecutorsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add executor' }));
    const token = screen.getByLabelText('Token');
    expect(token).toHaveAttribute('type', 'password');
    expect(token).toHaveAttribute('autocomplete', 'off');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mine' } });
    fireEvent.change(screen.getByLabelText('Routine fire URL'), { target: { value: FIRE } });
    fireEvent.change(token, { target: { value: 'sk-secret-9999' } });
    fireEvent.click(await screen.findByLabelText('o/web'));
    fireEvent.change(screen.getByLabelText('Max concurrent'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Daily run limit'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add executor' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      name: 'Mine', fireUrl: FIRE, token: 'sk-secret-9999', repoIds: ['r2'], enabled: true, maxConcurrent: 3, dailyRunLimit: 5,
    });
    await waitFor(() => expect(screen.queryByLabelText('Token')).not.toBeInTheDocument());
    expect(document.body.innerHTML).not.toContain('sk-secret-9999');
  });

  it('edits with the full PUT body, keeping repos that are not in the selected project', async () => {
    vi.spyOn(api, 'listExecutors').mockResolvedValue([executor({ repoIds: ['r1', 'other'] })]);
    const replace = vi.spyOn(api, 'replaceExecutor').mockResolvedValue(executor());
    render(<ExecutorsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Pascal laptop' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.queryByLabelText('Token')).not.toBeInTheDocument();
    expect(dialog.getByLabelText('other')).toBeChecked();
    fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace).toHaveBeenCalledWith('e1', {
      name: 'Renamed', fireUrl: FIRE, repoIds: ['r1', 'other'], maxConcurrent: 2, dailyRunLimit: 10, enabled: true,
    });
  });

  it('replaces the token in its own dialog without prefilling or showing it', async () => {
    vi.spyOn(api, 'listExecutors').mockResolvedValue([executor()]);
    const replaceToken = vi.spyOn(api, 'replaceExecutorToken').mockResolvedValue(undefined);
    render(<ExecutorsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Replace token of Pascal laptop' }));
    const input = screen.getByLabelText('New token');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: 'new-secret-5678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace token' }));
    await waitFor(() => expect(replaceToken).toHaveBeenCalledWith('e1', 'new-secret-5678'));
    await waitFor(() => expect(screen.queryByLabelText('New token')).not.toBeInTheDocument());
    expect(document.body.innerHTML).not.toContain('new-secret-5678');
  });

  it('toggles enabled with a full body built from the latest loaded executor', async () => {
    vi.spyOn(api, 'listExecutors').mockResolvedValue([executor({ maxConcurrent: 4 })]);
    const replace = vi.spyOn(api, 'replaceExecutor').mockResolvedValue(executor({ enabled: false }));
    render(<ExecutorsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable Pascal laptop' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('e1', {
      name: 'Pascal laptop', fireUrl: FIRE, repoIds: ['r1'], maxConcurrent: 4, dailyRunLimit: 10, enabled: false,
    }));
  });

  it('deletes only after confirmation', async () => {
    vi.spyOn(api, 'listExecutors').mockResolvedValue([executor()]);
    const del = vi.spyOn(api, 'deleteExecutor').mockResolvedValue(undefined);
    render(<ExecutorsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Pascal laptop' }));
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('e1'));
  });

  it('shows zod field errors next to the fields', async () => {
    vi.spyOn(api, 'listExecutors').mockResolvedValue([]);
    vi.spyOn(api, 'createExecutor').mockRejectedValue(
      new ApiError('bad', 400, 'bad', [{ path: 'fireUrl', message: 'Must look like a fire URL' }]),
    );
    render(<ExecutorsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add executor' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mine' } });
    fireEvent.change(screen.getByLabelText('Routine fire URL'), { target: { value: 'nope' } });
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 't' } });
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: 'Add executor' }));
    expect(await dialog.findByText('Must look like a fire URL')).toBeInTheDocument();
  });

  it('shows the not-configured message when saving answers 503', async () => {
    vi.spyOn(api, 'listExecutors').mockResolvedValue([]);
    vi.spyOn(api, 'createExecutor').mockRejectedValue(new ApiError('x', 503, 'Executors are not configured'));
    render(<ExecutorsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add executor' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mine' } });
    fireEvent.change(screen.getByLabelText('Routine fire URL'), { target: { value: FIRE } });
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 't' } });
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: 'Add executor' }));
    expect(await dialog.findByText(/EXECUTOR_SECRET_KEY/)).toBeInTheDocument();
  });
});
