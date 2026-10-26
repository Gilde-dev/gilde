import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api, type Job } from '@/lib/api';
import { JobCard, STATUS_EDGE } from './job-card';

const base = {
  id: 'j', projectId: 'p', repoId: 'r', featureId: null, title: 'Job', task: 't', acceptanceCriteria: [], status: 'queued',
  attempts: 0, queuedAt: '2026-01-01T00:00:00.000Z', prNumber: null, prUrl: null, branch: null, lastReason: null,
  needsApproval: false, approvalReason: null, dependsOn: [], blockedBy: [], pendingRevisions: 0, revision: 0, createdBy: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
} as Job;

describe('JobCard dependencies', () => {
  it('shows a waiting badge with the blocking titles', () => {
    const blockedBy = [{ id: 'a', title: 'Blocker', status: 'pr_open' as const }];
    render(<JobCard job={{ ...base, dependsOn: ['a'], blockedBy }} onOpen={() => {}} />);
    expect(screen.getByText('waiting on 1')).toHaveAttribute('title', 'Blocker (pr_open)');
  });

  it('shows a red badge when a dependency failed', () => {
    const blockedBy = [{ id: 'a', title: 'Blocker', status: 'rejected' as const }];
    render(<JobCard job={{ ...base, dependsOn: ['a'], blockedBy, failedDependency: true }} onOpen={() => {}} />);
    expect(screen.getByText('dependency failed')).toBeInTheDocument();
  });

  it('shows no badge without dependencies', () => {
    render(<JobCard job={base} onOpen={() => {}} />);
    expect(screen.queryByText(/waiting on/)).toBeNull();
  });
});

describe('JobCard feature chip', () => {
  it('shows the feature title when the job has a feature', () => {
    render(<JobCard job={{ ...base, featureId: 'f1' }} featureTitle="Checkout flow" onOpen={() => {}} />);
    expect(screen.getByText('Checkout flow')).toBeInTheDocument();
  });

  it('shows no chip without a feature', () => {
    render(<JobCard job={base} featureTitle="Checkout flow" onOpen={() => {}} />);
    expect(screen.queryByText('Checkout flow')).toBeNull();
  });
});

describe('JobCard proposals', () => {
  it('shows a badge while a proposal is pending', () => {
    render(<JobCard job={{ ...base, pendingRevisions: 1 }} onOpen={() => {}} />);
    expect(screen.getByText('proposal pending')).toBeInTheDocument();
  });

  it('shows no badge without pending proposals', () => {
    render(<JobCard job={base} onOpen={() => {}} />);
    expect(screen.queryByText('proposal pending')).toBeNull();
  });
});

describe('JobCard creator', () => {
  it('shows the creator as an avatar with initials', () => {
    render(<JobCard job={{ ...base, createdBy: { id: 'u1', name: 'Ann de Vries' } }} onOpen={() => {}} />);
    expect(screen.getByRole('img', { name: 'Ann de Vries' })).toHaveTextContent('AD');
    expect(screen.getByTitle('Created by Ann de Vries')).toBeInTheDocument();
  });

  it('shows the system fallback without a creator', () => {
    render(<JobCard job={base} onOpen={() => {}} />);
    expect(screen.getByRole('img', { name: 'System' })).toBeInTheDocument();
    expect(screen.getByTitle('Created by the system')).toBeInTheDocument();
  });
});

describe('JobCard metadata', () => {
  it('has a status colour on the left edge, parked red like rejected', () => {
    render(<JobCard job={{ ...base, status: 'merged' }} onOpen={() => {}} />);
    expect(screen.getByRole('button')).toHaveClass('border-l-4', STATUS_EDGE.merged);
    expect(STATUS_EDGE.parked).toBe(STATUS_EDGE.rejected);
    expect(STATUS_EDGE.dispatched).toContain('running');
  });

  it('shows status badge, mono repo, title, a two-line task excerpt, PR, branch, attempts and age', () => {
    const updatedAt = new Date(Date.now() - 3 * 3600_000).toISOString();
    render(
      <JobCard
        job={{ ...base, title: 'Add widgets', task: 'Make the widgets work', status: 'pr_open', prNumber: 4, prUrl: 'https://github.com/o/r/pull/4', branch: 'claude/gilde-1234abcd', attempts: 2, updatedAt }}
        repoName="o/r"
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('PR open')).toBeInTheDocument();
    expect(screen.getByText('o/r')).toHaveClass('font-mono');
    expect(screen.getByText('Add widgets')).toHaveClass('font-semibold');
    expect(screen.getByText('Make the widgets work')).toHaveClass('line-clamp-2');
    expect(screen.getByRole('link', { name: '#4' })).toHaveAttribute('href', 'https://github.com/o/r/pull/4');
    expect(screen.getByText('claude/gilde-1234abcd')).toHaveClass('truncate', 'font-mono');
    expect(screen.getByText('2 attempts')).toBeInTheDocument();
    expect(screen.getByText('3h')).toBeInTheDocument();
  });

  it('shows a PR number without a link when there is no URL, and no branch when none is known', () => {
    render(<JobCard job={{ ...base, prNumber: 9 }} onOpen={() => {}} />);
    expect(screen.getByText('#9')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByTitle(/claude\//)).toBeNull();
  });

  it('lets long titles, branches and repos wrap or truncate', () => {
    const long = 'x'.repeat(200);
    render(<JobCard job={{ ...base, title: long, branch: long }} repoName={long} onOpen={() => {}} />);
    expect(screen.getByText(long, { selector: 'div.text-md' })).toHaveClass('break-words');
    expect(screen.getAllByText(long, { selector: '.truncate' })).toHaveLength(2);
  });

  it('shows the parked reason and the approval reason', () => {
    render(<JobCard job={{ ...base, status: 'parked', lastReason: 'CI kept failing', needsApproval: true, approvalReason: 'Protected paths' }} onOpen={() => {}} />);
    expect(screen.getByText('CI kept failing')).toHaveClass('text-danger');
    expect(screen.getByText('Needs approval')).toHaveAttribute('title', 'Protected paths');
  });

  it('shows no CI, run or feedback counts and fetches nothing', () => {
    const getJob = vi.spyOn(api, 'getJob');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<JobCard job={{ ...base, prNumber: 4 }} onOpen={() => {}} />);
    expect(screen.queryByText(/CI /)).toBeNull();
    expect(screen.queryByText(/\bruns?\b/i)).toBeNull();
    expect(screen.queryByText(/feedback/i)).toBeNull();
    expect(getJob).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    getJob.mockRestore();
    fetchSpy.mockRestore();
  });
});

describe('JobCard opening', () => {
  it('opens on click, Enter and Space', () => {
    const onOpen = vi.fn();
    render(<JobCard job={base} onOpen={onOpen} />);
    const card = screen.getByRole('button', { name: /Job/ });
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    fireEvent.keyDown(card, { key: 'a' });
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it('is keyboard focusable with a visible focus ring and respects reduced motion', () => {
    render(<JobCard job={base} onOpen={() => {}} />);
    const card = screen.getByRole('button', { name: /Job/ });
    expect(card).toHaveAttribute('tabindex', '0');
    expect(card.className).toContain('focus-visible:ring-2');
    expect(card.className).toContain('motion-reduce:transition-none');
    expect(card.className).toContain('motion-reduce:hover:translate-y-0');
  });

  it('does not open from the PR link, by mouse or keyboard', () => {
    const onOpen = vi.fn();
    render(<JobCard job={{ ...base, prNumber: 4, prUrl: 'https://github.com/o/r/pull/4' }} onOpen={onOpen} />);
    const link = screen.getByRole('link', { name: '#4' });
    fireEvent.click(link);
    fireEvent.keyDown(link, { key: 'Enter' });
    fireEvent.keyDown(link, { key: ' ' });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does not open from the selection checkbox, by mouse or keyboard, and still selects', () => {
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    render(<JobCard job={{ ...base, status: 'triage' }} selected={false} onSelect={onSelect} onOpen={onOpen} />);
    const box = screen.getByLabelText('Select Job');
    fireEvent.click(box);
    fireEvent.keyDown(box, { key: ' ' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(true);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does not open from action buttons or their dialog', () => {
    const onOpen = vi.fn();
    render(<JobCard job={{ ...base, status: 'triage' }} onOpen={onOpen} />);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.keyDown(cancel, { key: 'Enter' });
    fireEvent.click(cancel);
    expect(onOpen).not.toHaveBeenCalled();
    const dialog = screen.queryByRole('dialog');
    if (dialog) fireEvent.click(dialog);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
