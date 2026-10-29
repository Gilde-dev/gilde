import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Project, type Repo } from '@/lib/api';
import { budgetStatus } from './budget.fixture';
import { ProjectSettingsView } from './project-settings-view';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'p1' }),
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/settings/projects/p1',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('./copilot-provider', () => ({ CopilotPageContext: () => null }));

const project = {
  id: 'p1', slug: 'shop', name: 'Shop', description: 'Webshop', dailyRunLimit: 20, maxAttempts: 3,
  runTimeoutMinutes: 60, retryOnChangesRequested: true, autoFixConflicts: false, paused: false, dailyBudgetUsd: null, weeklyBudgetUsd: 50, budgetSoftPct: 80, skillsLibrary: 'none', skillsLibraryRepoId: null,
} as Project;
/** What a PUT carries for the fixture project: every updatable field, nothing else. */
const FULL = {
  name: 'Shop', description: 'Webshop', dailyRunLimit: 20, maxAttempts: 3, runTimeoutMinutes: 60, retryOnChangesRequested: true, autoFixConflicts: false,
  skillsLibrary: 'none', skillsLibraryRepoId: null, dailyBudgetUsd: null, weeklyBudgetUsd: 50, budgetSoftPct: 80,
};
const repos = [{ id: 'r1', fullName: 'o/api', stacks: [], testCommands: [], paused: false, maxConcurrentJobs: 1, defaultBranch: 'main' }] as unknown as Repo[];

beforeEach(() => {
  vi.spyOn(api, 'getProject').mockResolvedValue(project);
  vi.spyOn(api, 'listRepos').mockResolvedValue(repos);
  vi.spyOn(api, 'getBudget').mockResolvedValue(budgetStatus({ pDay: { spent: 1.5 }, pWeek: { spent: 20, limit: 50, percent: 40 } }));
  vi.spyOn(api, 'getRepoWorkspace').mockResolvedValue({ cloned: false, headSha: null, fetchedAt: null, error: null });
});
afterEach(() => vi.restoreAllMocks());

describe('ProjectSettingsView', () => {
  it('saves general settings with a full PUT body and shows a saved state', async () => {
    const update = vi.spyOn(api, 'replaceProject').mockResolvedValue(project);
    render(<ProjectSettingsView />);
    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Shop 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith('p1', { ...FULL, name: 'Shop 2' });
  });

  it('sends the latest loaded values for the sections it did not edit, and keeps dirty inputs after the refresh', async () => {
    const update = vi.spyOn(api, 'replaceProject').mockResolvedValue(project);
    render(<ProjectSettingsView />);
    const name = await screen.findByLabelText('Name');
    // Someone else changes the policies and budget before the next save.
    vi.mocked(api.getProject).mockResolvedValue({ ...project, dailyRunLimit: 99, weeklyBudgetUsd: 0, skillsLibrary: 'folder' } as Project);
    fireEvent.change(name, { target: { value: 'Shop 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(update).toHaveBeenLastCalledWith('p1', { ...FULL, name: 'Shop 2' });
    // The refresh did not overwrite what is typed in the form...
    expect(screen.getByLabelText('Name')).toHaveValue('Shop 2');
    // ...and the next save carries the refreshed values of every other field, including a zero budget.
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenLastCalledWith('p1', { ...FULL, name: 'Shop 2', description: null, dailyRunLimit: 99, weeklyBudgetUsd: 0, skillsLibrary: 'folder' });
  });

  it('saves policies and shows a zod issue next to its field', async () => {
    const update = vi
      .spyOn(api, 'replaceProject')
      .mockRejectedValueOnce(
        new ApiError('bad', 400, 'bad', [{ path: 'dailyRunLimit', message: 'Number must be less than or equal to 500' }]),
      )
      .mockResolvedValueOnce(project);
    render(<ProjectSettingsView />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Policies' }));
    const limit = screen.getByLabelText('Daily run limit');
    fireEvent.change(limit, { target: { value: '900' } });
    fireEvent.click(screen.getByLabelText('Retry when changes are requested'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Number must be less than or equal to 500')).toBeInTheDocument();
    expect(limit).toHaveAttribute('aria-invalid', 'true');
    expect(update).toHaveBeenCalledWith('p1', { ...FULL, dailyRunLimit: 900, retryOnChangesRequested: false });
    fireEvent.change(limit, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('saves the automatic conflict fix toggle, off by default', async () => {
    const update = vi.spyOn(api, 'replaceProject').mockResolvedValue(project);
    render(<ProjectSettingsView />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Policies' }));
    const toggle = screen.getByLabelText(/Fix merge conflicts automatically/);
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith('p1', { ...FULL, autoFixConflicts: true });
  });

  it('switches the skills library to repo with a repo select', async () => {
    const update = vi.spyOn(api, 'replaceProject').mockResolvedValue(project);
    render(<ProjectSettingsView />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Skills library' }));
    expect(screen.queryByLabelText('Library repo')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Skills library' }), { target: { value: 'repo' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Library repo'), { target: { value: 'r1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('p1', { ...FULL, skillsLibrary: 'repo', skillsLibraryRepoId: 'r1' }));
  });

  it('pauses the project from the danger zone', async () => {
    const pause = vi.spyOn(api, 'setProjectPaused').mockResolvedValue({ ...project, paused: true });
    render(<ProjectSettingsView />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Danger zone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause project Shop' }));
    await waitFor(() => expect(pause).toHaveBeenCalledWith('p1', true));
  });

  it('lists repos with routine, manifest and workspace status', async () => {
    vi.spyOn(api, 'getRepoWorkspace').mockResolvedValue({ cloned: true, headSha: 'abcdef1234', fetchedAt: '2026-10-01T10:00:00.000Z', error: null });
    render(<ProjectSettingsView />);
    expect(await screen.findByText('o/api')).toBeInTheDocument();
    expect(await screen.findByText('abcdef1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause o/api' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh manifest o/api' })).toBeInTheDocument();
  });

  it('shows an empty state for an unknown project', async () => {
    vi.spyOn(api, 'getProject').mockRejectedValue(new ApiError('nope', 404));
    render(<ProjectSettingsView />);
    expect(await screen.findByText('Project not found')).toBeInTheDocument();
  });

  describe('Budget tab', () => {
    const open = async () => {
      render(<ProjectSettingsView />);
      fireEvent.click(await screen.findByRole('tab', { name: 'Budget' }));
    };

    it('shows current spend, UTC resets and the route project id budget beside the fields', async () => {
      await open();
      expect(api.getBudget).toHaveBeenCalledWith('p1');
      expect(screen.getByLabelText('Daily budget (estimated USD)')).toHaveValue('');
      expect(screen.getByLabelText('Weekly budget (estimated USD)')).toHaveValue('50');
      expect(screen.getByLabelText('Daily budget (estimated USD)')).toHaveAccessibleDescription(/Current day \(UTC\): \$1\.50 estimated · No limit · resets 2026-03-10 00:00 UTC/);
      expect(screen.getByLabelText('Weekly budget (estimated USD)')).toHaveAccessibleDescription(/\$20\.00 estimated · Limit \$50\.00/);
      expect(screen.getByText(/Global limits are set by the server environment/)).toBeInTheDocument();
    });

    it('saves valid limits and refreshes spend and project data', async () => {
      const update = vi.spyOn(api, 'replaceProject').mockResolvedValue(project);
      await open();
      fireEvent.change(screen.getByLabelText('Daily budget (estimated USD)'), { target: { value: '12.5' } });
      fireEvent.change(screen.getByLabelText('Warn at (% of limit)'), { target: { value: '90' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Saved')).toBeInTheDocument();
      expect(update).toHaveBeenCalledWith('p1', { ...FULL, dailyBudgetUsd: 12.5, weeklyBudgetUsd: 50, budgetSoftPct: 90 });
      expect(api.getBudget).toHaveBeenCalledTimes(2);
      expect(api.getProject).toHaveBeenCalledTimes(2);
    });

    it('sends null for a blank field and keeps an intentional zero', async () => {
      const update = vi.spyOn(api, 'replaceProject').mockResolvedValue(project);
      await open();
      fireEvent.change(screen.getByLabelText('Weekly budget (estimated USD)'), { target: { value: '' } });
      fireEvent.change(screen.getByLabelText('Daily budget (estimated USD)'), { target: { value: '0' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(update).toHaveBeenCalledWith('p1', { ...FULL, dailyBudgetUsd: 0, weeklyBudgetUsd: null, budgetSoftPct: 80 }));
    });

    it.each(['abc', '-1', '1e3', 'NaN', 'Infinity'])('blocks the invalid limit %s without sending it', async (bad) => {
      const update = vi.spyOn(api, 'replaceProject').mockResolvedValue(project);
      await open();
      const input = screen.getByLabelText('Daily budget (estimated USD)');
      fireEvent.change(input, { target: { value: bad } });
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText('Enter a number of 0 or more, or leave blank for no limit.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(update).not.toHaveBeenCalled();
    });

    it.each(['', '0', '101', 'x'])('blocks the soft percentage %j', async (bad) => {
      await open();
      fireEvent.change(screen.getByLabelText('Warn at (% of limit)'), { target: { value: bad } });
      expect(screen.getByText('Enter a percentage above 0 and up to 100.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });

    it('shows a server issue next to its own field only', async () => {
      vi.spyOn(api, 'replaceProject').mockRejectedValue(new ApiError('bad', 400, 'bad', [{ path: 'weeklyBudgetUsd', message: 'Too large' }]));
      await open();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Too large')).toBeInTheDocument();
      expect(screen.getByLabelText('Weekly budget (estimated USD)')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText('Daily budget (estimated USD)')).not.toHaveAttribute('aria-invalid');
    });

    it('shows a general server error as an alert', async () => {
      vi.spyOn(api, 'replaceProject').mockRejectedValue(new ApiError('Server exploded', 500));
      await open();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Server exploded');
    });

    it('does not claim spend while loading or after a failed load', async () => {
      vi.spyOn(api, 'getBudget').mockRejectedValue(new Error('x'));
      await open();
      expect(await screen.findAllByText(/Current spend could not be loaded/)).not.toHaveLength(0);
      expect(screen.queryByText(/\$0\.00/)).toBeNull();
    });
  });
});
