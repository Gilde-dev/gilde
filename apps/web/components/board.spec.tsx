import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api, JOB_STATUSES, type Feature, type Job, type JobStatus, type Repo } from '@/lib/api';
import { Board } from './board';

function job(status: JobStatus, extra: Partial<Job> = {}): Job {
  return {
    id: `id-${status}`,
    projectId: 'p',
    repoId: 'r',
    featureId: null,
    title: `Job ${status}`,
    task: 't',
    acceptanceCriteria: [],
    status,
    attempts: 2,
    queuedAt: '2026-01-01T00:00:00.000Z',
    prNumber: null,
    prUrl: null,
    branch: null,
    lastReason: null,
    needsApproval: false,
    approvalReason: null,
    dependsOn: [],
    blockedBy: [], pendingRevisions: 0, revision: 0, createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

const repos = [{ id: 'r', fullName: 'gilde-dev/gilde' } as Repo];
const jobs = JOB_STATUSES.map((s) => job(s));

describe('Board', () => {
  it('places each status in its lane', () => {
    render(<Board jobs={jobs} repos={repos} onOpen={() => {}} />);
    const expected: Record<string, string> = {
      Triage: 'Job triage',
      Queued: 'Job queued',
      Running: 'Job dispatched',
      'PR open': 'Job pr_open',
      'Awaiting review': 'Job awaiting_review',
      Parked: 'Job parked',
    };
    for (const [lane, title] of Object.entries(expected)) {
      expect(within(screen.getByRole('region', { name: lane })).getByText(title)).toBeInTheDocument();
    }
  });

  it('collapses the Done lane by default and expands it on demand', () => {
    render(<Board jobs={jobs} repos={repos} onOpen={() => {}} />);
    const done = screen.getByRole('region', { name: 'Done' });
    expect(within(done).queryByText('Job merged')).not.toBeInTheDocument();
    expect(within(done).getByText('3')).toBeInTheDocument();
    fireEvent.click(within(done).getByRole('button', { name: 'Show' }));
    for (const s of ['merged', 'rejected', 'cancelled']) expect(within(done).getByText(`Job ${s}`)).toBeInTheDocument();
  });

  it('shows card details and opens a job on click', () => {
    const onOpen = vi.fn();
    const parked = job('parked', { lastReason: 'x'.repeat(300), prNumber: 7, prUrl: 'https://github.com/o/r/pull/7' });
    render(<Board jobs={[parked]} repos={repos} onOpen={onOpen} />);
    expect(screen.getByText('gilde-dev/gilde')).toBeInTheDocument();
    expect(screen.getByText('2 attempts')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#7' })).toHaveAttribute('href', 'https://github.com/o/r/pull/7');
    expect(screen.getByText('x'.repeat(300))).toHaveClass('truncate');
    fireEvent.click(screen.getByText('Job parked'));
    expect(onOpen).toHaveBeenCalledWith(parked);
  });

  it('shows a Needs approval badge with the reason only when flagged', () => {
    const flagged = job('awaiting_review', { needsApproval: true, approvalReason: 'Protected paths changed' });
    render(<Board jobs={[flagged, job('pr_open')]} repos={repos} onOpen={vi.fn()} />);
    expect(screen.getAllByText('Needs approval')).toHaveLength(1);
    expect(screen.getByText('Needs approval')).toHaveAttribute('title', 'Protected paths changed');
  });

  it('queues the selected triage jobs through the bulk endpoint and shows warnings', async () => {
    const a = job('triage', { id: 'a', title: 'A' });
    const b = job('triage', { id: 'b', title: 'B' });
    const enqueueJobs = vi.spyOn(api, 'enqueueJobs').mockResolvedValue([
      { ...a, warnings: [{ dependencyId: 'x', message: 'still in triage' }] },
      { ...b, warnings: [] },
    ] as never);
    const onEnqueued = vi.fn();
    const onChanged = vi.fn();
    render(<Board jobs={[a, b]} repos={repos} onOpen={() => {}} onChanged={onChanged} onEnqueued={onEnqueued} />);
    const lane = screen.getByRole('region', { name: 'Triage' });
    expect(within(lane).getByRole('button', { name: 'Queue selected' })).toBeDisabled();
    fireEvent.click(within(lane).getByLabelText('Select A'));
    fireEvent.click(within(lane).getByLabelText('Select B'));
    fireEvent.click(within(lane).getByRole('button', { name: 'Queue selected (2)' }));
    await waitFor(() => expect(onEnqueued).toHaveBeenCalledWith(['A: still in triage']));
    expect(enqueueJobs).toHaveBeenCalledWith(['a', 'b']);
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows the API error when the bulk queue is rejected', async () => {
    const a = job('triage', { id: 'a', title: 'A' });
    vi.spyOn(api, 'enqueueJobs').mockRejectedValue(Object.assign(new Error('x'), { detail: 'Jobs not in triage: a' }));
    render(<Board jobs={[a]} repos={repos} onOpen={() => {}} />);
    fireEvent.click(screen.getByLabelText('Select A'));
    fireEvent.click(screen.getByRole('button', { name: 'Queue selected (1)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Jobs not in triage: a');
  });

  it('has no selection boxes outside the Triage lane', () => {
    render(<Board jobs={[job('queued')]} repos={repos} onOpen={() => {}} />);
    expect(screen.queryByLabelText(/^Select /)).not.toBeInTheDocument();
  });

  it('filters by feature and shows the feature chip', () => {
    const inFeature = [job('queued', { id: 'a', title: 'In feature', featureId: 'f1' }), job('queued', { id: 'b', title: 'Loose' })];
    const features = [{ id: 'f1', title: 'Checkout flow' } as Feature];
    const { rerender } = render(<Board jobs={inFeature} repos={repos} features={features} onOpen={() => {}} />);
    expect(screen.getByText('Checkout flow')).toBeInTheDocument();
    expect(screen.getByText('Loose')).toBeInTheDocument();
    rerender(<Board jobs={inFeature} repos={repos} features={features} featureFilter="f1" onOpen={() => {}} />);
    expect(screen.queryByText('Loose')).toBeNull();
    expect(screen.getByText('In feature')).toBeInTheDocument();
    rerender(<Board jobs={inFeature} repos={repos} features={features} featureFilter="none" onOpen={() => {}} />);
    expect(screen.queryByText('In feature')).toBeNull();
    expect(screen.getByText('Loose')).toBeInTheDocument();
  });

  it('shows filtered counts in the lane headers', () => {
    const list = [job('queued', { id: 'a', title: 'A', featureId: 'f1' }), job('queued', { id: 'b', title: 'B' }), job('queued', { id: 'c', title: 'C' })];
    const { rerender } = render(<Board jobs={list} repos={repos} onOpen={() => {}} />);
    expect(within(screen.getByRole('region', { name: 'Queued' })).getByText('3')).toBeInTheDocument();
    rerender(<Board jobs={list} repos={repos} featureFilter="f1" totalJobs={3} onOpen={() => {}} />);
    expect(within(screen.getByRole('region', { name: 'Queued' })).getByText('1')).toBeInTheDocument();
  });

  it('shows dashed placeholders in empty lanes and scrolls horizontally', () => {
    const { container } = render(<Board jobs={[job('queued')]} repos={repos} onOpen={() => {}} />);
    const placeholders = screen.getAllByText('Nothing here');
    expect(placeholders).toHaveLength(5); // the collapsed Done lane shows none
    expect(placeholders[0]).toHaveClass('border-dashed');
    expect(container.firstChild).toHaveClass('overflow-x-auto');
  });

  it('gives each lane a tinted light surface and a raised dark surface', () => {
    render(<Board jobs={[job('queued')]} repos={repos} onOpen={() => {}} />);
    const lane = screen.getByRole('region', { name: 'Queued' });
    expect(lane).toHaveClass('rounded-xl', 'bg-info-soft', 'dark:bg-lane');
  });
});

describe('Board states', () => {
  it('shows one icon empty state with a working New job action for a genuinely empty board', () => {
    const onNewJob = vi.fn();
    render(<Board jobs={[]} repos={repos} onOpen={() => {}} onNewJob={onNewJob} />);
    expect(screen.getByText('No jobs yet')).toBeInTheDocument();
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.queryByText('Nothing here')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New job' }));
    expect(onNewJob).toHaveBeenCalledTimes(1);
  });

  it('does not offer New job without a callback', () => {
    render(<Board jobs={[]} repos={repos} onOpen={() => {}} />);
    expect(screen.queryByRole('button', { name: 'New job' })).toBeNull();
  });

  it('shows a loading state, not an empty board, while the list is absent', () => {
    render(<Board jobs={[]} repos={repos} loading onOpen={() => {}} onNewJob={() => {}} />);
    expect(screen.getByRole('status', { name: 'Loading jobs' })).toBeInTheDocument();
    expect(screen.queryByText('No jobs yet')).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('shows a load error, not an empty board', () => {
    render(<Board jobs={[]} repos={repos} error="boom" onOpen={() => {}} onNewJob={() => {}} />);
    expect(screen.getByText('Jobs could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.queryByText('No jobs yet')).toBeNull();
  });

  it('shows a filter-empty state with a working reset when filters hide every job', () => {
    const onReset = vi.fn();
    render(<Board jobs={[]} totalJobs={4} repos={repos} onResetFilters={onReset} onOpen={() => {}} onNewJob={() => {}} />);
    expect(screen.getByText('No jobs match the filters')).toBeInTheDocument();
    expect(screen.queryByText('No jobs yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(onReset).toHaveBeenCalled();
  });

  it('shows the filter-empty state when the feature filter hides every job', () => {
    render(<Board jobs={[job('queued')]} repos={repos} featureFilter="f9" onOpen={() => {}} />);
    expect(screen.getByText('No jobs match the filters')).toBeInTheDocument();
  });

  it('does not render CI on cards or accept ci props', () => {
    render(<Board jobs={[job('pr_open', { prNumber: 3 })]} repos={repos} onOpen={() => {}} />);
    expect(screen.queryByText(/^CI /)).toBeNull();
  });
});
