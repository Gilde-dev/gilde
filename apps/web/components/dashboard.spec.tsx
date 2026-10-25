import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Job, type JobDetail, type Project } from '@/lib/api';
import { Dashboard } from './dashboard';

const nav = vi.hoisted(() => ({ search: '', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const job = { id: 'j9', projectId: 'p2', repoId: 'r', featureId: null, title: 'Deep linked job', task: 't', acceptanceCriteria: [], status: 'merged', attempts: 1, dependsOn: [], blockedBy: [], pendingRevisions: 0, revision: 0 } as unknown as Job;
const detail = { ...job, feedback: [], runs: [] } as unknown as JobDetail;
const projects = [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }] as Project[];

beforeEach(() => {
  nav.search = '';
  nav.replace.mockClear();
  vi.spyOn(api, 'listProjects').mockResolvedValue(projects);
  vi.spyOn(api, 'listRepos').mockResolvedValue([]);
  vi.spyOn(api, 'listJobs').mockResolvedValue([]); // the job is outside the board's list
  vi.spyOn(api, 'listFeatures').mockResolvedValue([]);
  vi.spyOn(api, 'getDispatchStatus').mockResolvedValue({ result: null } as never);
  vi.spyOn(api, 'listJobRevisions').mockResolvedValue([]);
  vi.spyOn(api, 'getJob').mockResolvedValue(detail);
});
afterEach(() => vi.restoreAllMocks());

describe('Dashboard job deep link', () => {
  it('opens the job by id even when the board does not list it', async () => {
    nav.search = 'project=p2&job=j9';
    render(<Dashboard />);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(await screen.findAllByText('Deep linked job')).not.toHaveLength(0);
    expect(api.getJob).toHaveBeenCalledWith('j9');
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('switches to the job project when the link names another or none', async () => {
    nav.search = 'project=p1&job=j9';
    render(<Dashboard />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/?project=p2&job=j9'));
  });

  it('closes without reopening and drops the job parameter', async () => {
    nav.search = 'project=p2&job=j9';
    render(<Dashboard />);
    await screen.findByRole('dialog');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(nav.replace).toHaveBeenCalledWith('/?project=p2');
    await act(async () => {});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a message and cleans the URL for a missing or malformed id', async () => {
    vi.mocked(api.getJob).mockRejectedValue(new ApiError('Not Found', 404));
    nav.search = 'project=p2&job=%3Cbad%3E';
    render(<Dashboard />);
    expect(await screen.findByText(/could not be opened/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(nav.replace).toHaveBeenCalledWith('/?project=p2');
  });

  it('does nothing extra without a job parameter', async () => {
    nav.search = 'project=p1';
    render(<Dashboard />);
    await screen.findByText('One', { selector: 'h2' });
    expect(api.getJob).not.toHaveBeenCalled();
  });
});
