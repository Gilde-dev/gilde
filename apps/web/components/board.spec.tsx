import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JOB_STATUSES, type Job, type JobStatus, type Repo } from '@/lib/api';
import { Board } from './board';

function job(status: JobStatus, extra: Partial<Job> = {}): Job {
  return {
    id: `id-${status}`,
    projectId: 'p',
    repoId: 'r',
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
});
