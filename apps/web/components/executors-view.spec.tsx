import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Executor, type Project, type Repo } from '@/lib/api';
import { ROUTINE_DESCRIPTION } from '@/lib/routine-description';
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

type Dlg = ReturnType<typeof within>;
const SECRET = 'sk-ant-oat01-secret-9999';

async function openWizard() {
  vi.spyOn(api, 'listExecutors').mockResolvedValue([]);
  render(<ExecutorsView />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add executor' }));
  return within(screen.getByRole('dialog'));
}
const next = (d: Dlg) => fireEvent.click(d.getByRole('button', { name: 'Next' }));
const fillStep3 = (d: Dlg, token = SECRET) => {
  fireEvent.change(d.getByLabelText('Routine fire URL'), { target: { value: FIRE } });
  fireEvent.change(d.getByLabelText('Token'), { target: { value: token } });
};
async function toStep4(d: Dlg) {
  next(d);
  next(d);
  fillStep3(d);
  next(d);
  fireEvent.change(await d.findByLabelText('Name'), { target: { value: 'Mine' } });
}

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

  it('explains the routine in step 1 with a copyable description and no secrets', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const d = await openWizard();
    expect(d.getByText('Step 1 of 4')).toBeInTheDocument();
    expect(d.getByRole('heading', { name: 'Create a routine in Claude Code' })).toHaveFocus();
    expect(d.getByRole('link', { name: 'claude.ai/code/routines' })).toHaveAttribute('href', 'https://claude.ai/code/routines');
    expect(d.getByText(ROUTINE_DESCRIPTION)).toBeInTheDocument();
    expect(d.getByText(/OpenTelemetry settings from the README/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('OTEL_INGEST_TOKEN');
    expect(d.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    expect(d.getByRole('listitem', { current: 'step' })).toHaveTextContent('Create a routine in Claude Code');
    fireEvent.click(d.getByRole('button', { name: 'Copy description' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ROUTINE_DESCRIPTION));
    expect(await d.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('explains the API trigger in step 2 with the one-time token warning and a safe docs link', async () => {
    const d = await openWizard();
    next(d);
    expect(d.getByText('Step 2 of 4')).toBeInTheDocument();
    expect(d.getByRole('heading', { name: 'Add an API trigger' })).toHaveFocus();
    expect(d.getByText(/Add another trigger/)).toBeInTheDocument();
    expect(d.getByText(/Choose .API./)).toBeInTheDocument();
    expect(d.getByText(/Generate token/)).toBeInTheDocument();
    expect(d.getByText(/shown only once/)).toBeInTheDocument();
    expect(d.getByText(/revokes the previous one/)).toBeInTheDocument();
    const link = d.getByRole('link', { name: 'Routines fire documentation' });
    expect(link).toHaveAttribute('href', 'https://platform.claude.com/docs/en/api/claude-code/routines-fire');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('validates the fire URL live and disables Next until URL and token are there', async () => {
    const d = await openWizard();
    next(d);
    next(d);
    const nextButton = d.getByRole('button', { name: 'Next' });
    expect(nextButton).toBeDisabled();
    const url = d.getByLabelText('Routine fire URL');
    fireEvent.change(url, { target: { value: 'https://example.com/x' } });
    expect(d.getByText(/Must look like https:\/\/api\.anthropic\.com/)).toBeInTheDocument();
    fireEvent.change(url, { target: { value: FIRE } });
    expect(d.queryByText(/Must look like/)).not.toBeInTheDocument();
    expect(nextButton).toBeDisabled();
    const token = d.getByLabelText('Token');
    expect(token).toHaveAttribute('type', 'password');
    expect(token).toHaveAttribute('autocomplete', 'off');
    fireEvent.change(token, { target: { value: 'abc' } });
    expect(d.getByText(/does not start with sk-ant-oat01-/)).toBeInTheDocument();
    expect(nextButton).toBeEnabled();
    fireEvent.change(token, { target: { value: SECRET } });
    expect(d.queryByText(/does not start with/)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('keeps the entered values when going back, and needs a name on the last step', async () => {
    const d = await openWizard();
    next(d);
    next(d);
    fillStep3(d);
    next(d);
    expect(d.getByText('Step 4 of 4')).toBeInTheDocument();
    expect(d.getByRole('button', { name: 'Create executor' })).toBeDisabled();
    fireEvent.change(d.getByLabelText('Name'), { target: { value: 'Mine' } });
    expect(d.getByRole('button', { name: 'Create executor' })).toBeEnabled();
    fireEvent.click(d.getByRole('button', { name: 'Back' }));
    expect(d.getByLabelText('Routine fire URL')).toHaveValue(FIRE);
    expect(d.getByLabelText('Token')).toHaveValue(SECRET);
    fireEvent.click(d.getByRole('button', { name: 'Back' }));
    fireEvent.click(d.getByRole('button', { name: 'Back' }));
    expect(d.getByText('Step 1 of 4')).toBeInTheDocument();
    next(d);
    next(d);
    next(d);
    expect(d.getByLabelText('Name')).toHaveValue('Mine');
  });

  it('creates the executor from a summary step, with the token never displayed and cleared after', async () => {
    const create = vi.spyOn(api, 'createExecutor').mockResolvedValue(executor());
    const d = await openWizard();
    await toStep4(d);
    fireEvent.click(await d.findByLabelText('o/web'));
    fireEvent.change(d.getByLabelText('Max concurrent'), { target: { value: '3' } });
    fireEvent.change(d.getByLabelText('Daily run limit'), { target: { value: '5' } });
    expect(d.getByLabelText('Summary')).toHaveTextContent('Token: set');
    expect(d.getByLabelText('Summary')).toHaveTextContent('Mine');
    expect(d.getByLabelText('Summary')).toHaveTextContent('o/web');
    expect(document.body.innerHTML).not.toContain(SECRET);
    fireEvent.click(d.getByRole('button', { name: 'Create executor' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      name: 'Mine', fireUrl: FIRE, token: SECRET, repoIds: ['r2'], enabled: true, maxConcurrent: 3, dailyRunLimit: 5,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('discards everything on close', async () => {
    const d = await openWizard();
    next(d);
    next(d);
    fillStep3(d);
    fireEvent.click(d.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add executor' }));
    const again = within(screen.getByRole('dialog'));
    next(again);
    next(again);
    expect(again.getByLabelText('Routine fire URL')).toHaveValue('');
    expect(again.getByLabelText('Token')).toHaveValue('');
  });

  it('jumps back to the step of a field error from the API', async () => {
    vi.spyOn(api, 'createExecutor').mockRejectedValue(
      new ApiError('bad', 400, 'bad', [{ path: 'fireUrl', message: 'Rejected fire URL' }]),
    );
    const d = await openWizard();
    await toStep4(d);
    fireEvent.click(d.getByRole('button', { name: 'Create executor' }));
    expect(await d.findByText('Rejected fire URL')).toBeInTheDocument();
    expect(d.getByText('Step 3 of 4')).toBeInTheDocument();
    expect(d.getByRole('heading', { name: 'Paste the fire URL and token' })).toHaveFocus();
  });

  it('stays on the last step for a name error', async () => {
    vi.spyOn(api, 'createExecutor').mockRejectedValue(
      new ApiError('bad', 400, 'bad', [{ path: 'name', message: 'Name taken' }]),
    );
    const d = await openWizard();
    await toStep4(d);
    fireEvent.click(d.getByRole('button', { name: 'Create executor' }));
    expect(await d.findByText('Name taken')).toBeInTheDocument();
    expect(d.getByText('Step 4 of 4')).toBeInTheDocument();
  });

  it('shows the not-configured message when creating answers 503', async () => {
    vi.spyOn(api, 'createExecutor').mockRejectedValue(new ApiError('x', 503, 'Executors are not configured'));
    const d = await openWizard();
    await toStep4(d);
    fireEvent.click(d.getByRole('button', { name: 'Create executor' }));
    expect(await d.findByText(/EXECUTOR_SECRET_KEY/)).toBeInTheDocument();
  });

  it('edits with the single form, not the wizard', async () => {
    vi.spyOn(api, 'listExecutors').mockResolvedValue([executor()]);
    render(<ExecutorsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Pascal laptop' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.queryByText(/Step \d of 4/)).not.toBeInTheDocument();
    expect(dialog.getByLabelText('Routine fire URL')).toHaveValue(FIRE);
    expect(dialog.getByLabelText('Name')).toBeInTheDocument();
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

});
