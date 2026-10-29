import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Job, type JobDetail, type JobStatus, type Project } from '@/lib/api';
import { budgetStatus } from './budget.fixture';
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
  vi.spyOn(api, 'getBudget').mockImplementation(async (id) => budgetStatus({ projectId: id }));
  vi.spyOn(api, 'getDispatchStatus').mockResolvedValue({ result: null } as never);
  vi.spyOn(api, 'listJobRevisions').mockResolvedValue([]);
  vi.spyOn(api, 'getJob').mockResolvedValue(detail);
  vi.spyOn(api, 'me').mockResolvedValue({ id: 'u1', name: 'Me', email: 'me@x.nl' });
  vi.spyOn(api, 'scoutActivity').mockResolvedValue({ projectId: 'p2', enabled: false, model: null, scoutUserId: null, disabledReason: null, suggestionsThisWeek: 0, weekStart: '2026-10-26', lastWakeAt: null });
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
    await screen.findByText('One', { selector: 'h1' });
    expect(api.getJob).not.toHaveBeenCalled();
  });
});

describe('Dashboard without projects', () => {
  it('shows an empty state linking to the project settings', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([]);
    render(<Dashboard />);
    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to project settings' })).toHaveAttribute('href', '/settings/projects');
  });
});

function listed(status: JobStatus, extra: Partial<Job> = {}): Job {
  return {
    ...job, id: `${status}-${Math.random()}`, projectId: 'p2', title: `Job ${status} ${extra.id ?? ''}`, status, needsApproval: false, createdBy: null, ...extra,
  } as Job;
}
const stat = (label: string) =>
  within(within(screen.getByRole('region', { name: 'Job counts' })).getByText(label).closest('div')!).getByText(/^(\d+|…|–)$/).textContent;

describe('Dashboard stats', () => {
  beforeEach(() => {
    nav.search = 'project=p2';
  });

  it('counts the four loaded-list stats, with overlapping attention predicates counted once', async () => {
    vi.mocked(api.listJobs).mockResolvedValue([
      listed('dispatched'), listed('pr_open'), listed('pr_open'),
      listed('awaiting_review'), listed('awaiting_review', { needsApproval: true }),
      listed('triage'), listed('triage'), listed('triage'),
      listed('parked', { needsApproval: true, failedDependency: true }),
      listed('queued', { failedDependency: true }),
      listed('merged'),
    ]);
    render(<Dashboard />);
    await waitFor(() => expect(stat('In progress')).toBe('3'));
    expect(stat('Awaiting review')).toBe('2');
    expect(stat('Triage (waiting for you)')).toBe('3');
    expect(stat('Needs attention')).toBe('3'); // approval on an awaiting_review job, the parked job once, the failed dependency
  });

  it('is not changed by the creator and feature filters, which only change the board', async () => {
    vi.mocked(api.listJobs).mockResolvedValue([
      listed('pr_open', { id: 'a', createdBy: { id: 'u1', name: 'Me' } }),
      listed('pr_open', { id: 'b', createdBy: { id: 'u2', name: 'Other' }, featureId: 'f1' }),
      listed('triage', { id: 'c', createdBy: null }),
    ]);
    vi.mocked(api.listFeatures).mockResolvedValue([{ id: 'f1', title: 'Feature one' }] as never);
    render(<Dashboard />);
    await waitFor(() => expect(stat('In progress')).toBe('2'));
    fireEvent.click(screen.getByRole('button', { name: 'Me' }));
    expect(await screen.findByText('Job pr_open a')).toBeInTheDocument();
    expect(screen.queryByText('Job pr_open b')).toBeNull();
    expect(stat('In progress')).toBe('2');
    expect(stat('Triage (waiting for you)')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Anyone' }));
    await screen.findByLabelText('Feature filter');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Feature one' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Feature filter'), { target: { value: 'f1' } });
    expect(screen.queryByText('Job pr_open a')).toBeNull();
    expect(stat('In progress')).toBe('2');
    expect(api.listJobs).toHaveBeenCalledTimes(1);
    expect(api.listJobs).toHaveBeenCalledWith('p2'); // never createdBy=me
  });

  it('discloses that the counts cover the loaded list, up to 200 jobs', async () => {
    vi.mocked(api.listJobs).mockResolvedValue([listed('triage')]);
    render(<Dashboard />);
    expect(await screen.findByText(/Counts cover the jobs loaded for this project, up to 200/)).toBeInTheDocument();
    expect(screen.queryByText(/limit, so older jobs/)).toBeNull();
  });

  it('warns that older jobs are not counted when the list is at its limit', async () => {
    vi.mocked(api.listJobs).mockResolvedValue(Array.from({ length: 200 }, (_, i) => listed('merged', { id: String(i) })));
    render(<Dashboard />);
    expect(await screen.findByText(/at its limit, so older jobs are not counted/)).toBeInTheDocument();
  });

  it('distinguishes loading and a load error from a real zero', async () => {
    let resolve!: (jobs: Job[]) => void;
    vi.mocked(api.listJobs).mockReturnValue(new Promise((r) => (resolve = r)));
    render(<Dashboard />);
    await screen.findByText('Triage (waiting for you)');
    expect(stat('In progress')).toBe('…');
    expect(screen.getByRole('status', { name: 'Loading jobs' })).toBeInTheDocument();
    expect(screen.queryByText('No jobs yet')).toBeNull();
    await act(async () => resolve([]));
    expect(stat('In progress')).toBe('0');
    expect(stat('Needs attention')).toBe('0');
    expect(await screen.findByText('No jobs yet')).toBeInTheDocument();
  });

  it('shows a dash and an error state, not zero, when the list cannot be loaded', async () => {
    vi.mocked(api.listJobs).mockRejectedValue(new Error('API down'));
    render(<Dashboard />);
    expect(await screen.findByText('Jobs could not be loaded')).toBeInTheDocument();
    expect(stat('In progress')).toBe('–');
    expect(screen.queryByText('No jobs yet')).toBeNull();
  });

  it('shows the empty board with a New job action that opens the dialog', async () => {
    render(<Dashboard />);
    const empty = (await screen.findByText('No jobs yet')).parentElement!;
    fireEvent.click(within(empty).getByRole('button', { name: 'New job' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('header shows the project, repos and paused state, and New job opens the dialog', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([{ id: 'p2', name: 'Two', paused: true }] as Project[]);
    vi.mocked(api.listRepos).mockResolvedValue([{ id: 'r', fullName: 'o/api' }] as never);
    render(<Dashboard />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Two' })).toBeInTheDocument();
    expect(await screen.findByText(/o\/api/)).toHaveTextContent('o/api');
    expect(screen.getByText(/Paused/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume project Two' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'New job' })[0]);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('recounts for another project after a switch', async () => {
    vi.mocked(api.listJobs).mockImplementation(async (id) =>
      id === 'p2' ? [listed('triage'), listed('triage')] : [{ ...listed('triage'), projectId: 'p1' }],
    );
    const { rerender } = render(<Dashboard />);
    await waitFor(() => expect(stat('Triage (waiting for you)')).toBe('2'));
    nav.search = 'project=p1';
    rerender(<Dashboard />);
    await waitFor(() => expect(stat('Triage (waiting for you)')).toBe('1'));
    expect(api.listJobs).toHaveBeenCalledWith('p1');
  });

  it('never fetches job details for cards or stats', async () => {
    vi.mocked(api.listJobs).mockResolvedValue([listed('pr_open', { prNumber: 3 }), listed('triage')]);
    render(<Dashboard />);
    await screen.findByText('Job pr_open');
    expect(api.getJob).not.toHaveBeenCalled();
    expect(api.listJobRevisions).not.toHaveBeenCalled();
  });

  it('opens a card in the modal, which fetches that job explicitly', async () => {
    vi.mocked(api.listJobs).mockResolvedValue([listed('queued', { id: 'q', title: 'Open me' })]);
    render(<Dashboard />);
    fireEvent.click(await screen.findByText('Open me'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('Dashboard Suggested badges', () => {
  const scoutJob = (over: Partial<Job>) => ({ ...listed('triage'), ...over }) as Job;

  it('reads the scout identity once and marks jobs by creator id, while the scout is on or off', async () => {
    nav.search = 'project=p2';
    vi.mocked(api.scoutActivity).mockResolvedValue({ projectId: 'p2', enabled: false, model: null, scoutUserId: 'bot', disabledReason: null, suggestionsThisWeek: 2, weekStart: '2026-10-26', lastWakeAt: null });
    vi.mocked(api.listJobs).mockResolvedValue([
      scoutJob({ id: 'a', title: 'By the bot', createdBy: { id: 'bot', name: 'Verkenner' } }),
      scoutJob({ id: 'b', title: 'By a namesake', createdBy: { id: 'human', name: 'Verkenner' } }),
      scoutJob({ id: 'c', title: 'By nobody', createdBy: null }),
    ]);
    render(<Dashboard />);
    await screen.findByText('By the bot');
    await waitFor(() => expect(screen.getAllByText('Suggested')).toHaveLength(1));
    expect(within(screen.getByText('By the bot').closest('[role="button"]') as HTMLElement).getByText('Suggested')).toBeInTheDocument();
    expect(within(screen.getByText('By a namesake').closest('[role="button"]') as HTMLElement).queryByText('Suggested')).toBeNull();
    expect(api.scoutActivity).toHaveBeenCalledTimes(1);
    expect(api.scoutActivity).toHaveBeenCalledWith('p2');
    expect(api.getJob).not.toHaveBeenCalled();
    // Counts are unchanged by the badge: all three are in triage.
    expect(stat('Triage (waiting for you)')).toBe('3');
  });

  it('shows the board without badges when the scout read fails', async () => {
    nav.search = 'project=p2';
    vi.mocked(api.scoutActivity).mockRejectedValue(new Error('boom'));
    vi.mocked(api.listJobs).mockResolvedValue([scoutJob({ title: 'By the bot', createdBy: { id: 'bot', name: 'Verkenner' } })]);
    render(<Dashboard />);
    await screen.findByText('By the bot');
    expect(screen.queryByText('Suggested')).toBeNull();
  });
});

describe('Dashboard budget banner', () => {
  beforeEach(() => {
    nav.search = 'project=p2';
  });

  it('shows no banner when every period is ok', async () => {
    render(<Dashboard />);
    await waitFor(() => expect(api.getBudget).toHaveBeenCalledWith('p2'));
    expect(screen.queryByRole('status', { name: 'Estimated budget' })).toBeNull();
  });

  it('shows the selected project warning, then the new project status after a switch, without refetching jobs for it', async () => {
    vi.mocked(api.getBudget).mockImplementation(async (id) =>
      id === 'p2' ? budgetStatus({ projectId: 'p2', pDay: { state: 'soft', limit: 10, percent: 90, spent: 9 } }) : budgetStatus({ projectId: id }),
    );
    const { rerender } = render(<Dashboard />);
    const banner = await screen.findByRole('status', { name: 'Estimated budget' });
    expect(banner).toHaveClass('text-warning');
    expect(screen.getByRole('link', { name: 'Project budget settings' })).toHaveAttribute('href', '/settings/projects/p2?project=p2');
    nav.search = 'project=p1';
    rerender(<Dashboard />);
    await waitFor(() => expect(api.getBudget).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Estimated budget' })).toBeNull());
  });

  it('does not change the job counts and keeps the dispatch strip', async () => {
    vi.mocked(api.getBudget).mockResolvedValue(budgetStatus({ projectId: 'p2', gWeek: { state: 'hard', limit: 5, percent: 200, spent: 10 }, status: { hardBlocked: true, recovery: 'reset', recoversAt: '2026-03-16T00:00:00.000Z' } }));
    vi.mocked(api.listJobs).mockResolvedValue([{ ...job, id: 'a', projectId: 'p2', status: 'triage' } as Job]);
    render(<Dashboard />);
    await screen.findByText(/Dispatch paused by budget/);
    await waitFor(() => expect(within(screen.getByText('Triage (waiting for you)').parentElement!).getByText('1')).toBeInTheDocument());
    expect(api.getJob).not.toHaveBeenCalled();
    expect(api.getBudget).toHaveBeenCalledTimes(1);
  });

  it('says the budget is unavailable when the request fails', async () => {
    vi.mocked(api.getBudget).mockRejectedValue(new Error('down'));
    render(<Dashboard />);
    expect(await screen.findByText('Estimated budget status is unavailable right now.')).toBeInTheDocument();
  });
});

describe('Dashboard reconcile and sync placement', () => {
  it('reconciles the selected project, never the global endpoint', async () => {
    nav.search = 'project=p2';
    const reconcile = vi.spyOn(api, 'reconcileProject').mockResolvedValue({ checked: 2, corrected: 0 });
    render(<Dashboard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reconcile now' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Checked 2 jobs; nothing needed correcting.');
    expect(reconcile).toHaveBeenCalledWith('p2');
  });

  it('offers Sync from GitHub in the job dialog but not on board cards', async () => {
    nav.search = 'project=p2';
    const pr = { ...job, status: 'pr_open', prNumber: 5 } as Job;
    vi.mocked(api.listJobs).mockResolvedValue([pr]);
    vi.mocked(api.getJob).mockResolvedValue({ ...detail, ...pr } as JobDetail);
    render(<Dashboard />);
    const card = (await screen.findAllByText('Deep linked job'))[0];
    expect(screen.queryByRole('button', { name: 'Sync from GitHub' })).toBeNull();
    fireEvent.click(card);
    expect(await screen.findByRole('button', { name: 'Sync from GitHub' })).toBeInTheDocument();
  });
});
