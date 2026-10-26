import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Project, type Repo } from '@/lib/api';
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
  runTimeoutMinutes: 60, retryOnChangesRequested: true, paused: false, skillsLibrary: 'none', skillsLibraryRepoId: null,
} as Project;
const repos = [{ id: 'r1', fullName: 'o/api', stacks: [], testCommands: [], paused: false, maxConcurrentJobs: 1, defaultBranch: 'main' }] as unknown as Repo[];

beforeEach(() => {
  vi.spyOn(api, 'getProject').mockResolvedValue(project);
  vi.spyOn(api, 'listRepos').mockResolvedValue(repos);
  vi.spyOn(api, 'getRepoWorkspace').mockResolvedValue({ cloned: false, headSha: null, fetchedAt: null, error: null });
});
afterEach(() => vi.restoreAllMocks());

describe('ProjectSettingsView', () => {
  it('saves general settings with PATCH and shows a saved state', async () => {
    const update = vi.spyOn(api, 'updateProject').mockResolvedValue(project);
    render(<ProjectSettingsView />);
    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Shop 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith('p1', { name: 'Shop 2', description: 'Webshop' });
  });

  it('saves policies and shows a zod issue next to its field', async () => {
    const update = vi
      .spyOn(api, 'updateProject')
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
    expect(update).toHaveBeenCalledWith('p1', { dailyRunLimit: 900, maxAttempts: 3, runTimeoutMinutes: 60, retryOnChangesRequested: false });
    fireEvent.change(limit, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('switches the skills library to repo with a repo select', async () => {
    const update = vi.spyOn(api, 'updateProject').mockResolvedValue(project);
    render(<ProjectSettingsView />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Skills library' }));
    expect(screen.queryByLabelText('Library repo')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Skills library' }), { target: { value: 'repo' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Library repo'), { target: { value: 'r1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('p1', { skillsLibrary: 'repo', skillsLibraryRepoId: 'r1' }));
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
});
