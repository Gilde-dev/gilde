import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Job } from '@/lib/api';
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
  it('shows the creator initials', () => {
    render(<JobCard job={{ ...base, createdBy: { id: 'u1', name: 'Ann de Vries' } }} onOpen={() => {}} />);
    expect(screen.getByText('AD')).toHaveAttribute('title', 'Created by Ann de Vries');
  });

  it('shows System without a creator', () => {
    render(<JobCard job={base} onOpen={() => {}} />);
    expect(screen.getByText('System')).toBeInTheDocument();
  });
});

describe('JobCard polish', () => {
  it('has a status colour on the left edge', () => {
    render(<JobCard job={{ ...base, status: 'merged' }} onOpen={() => {}} />);
    expect(screen.getByRole('button')).toHaveClass('border-l-4', STATUS_EDGE.merged);
  });

  it('shows repo in mono, PR, CI and a compact age', () => {
    const updatedAt = new Date(Date.now() - 3 * 3600_000).toISOString();
    render(<JobCard job={{ ...base, prNumber: 4, updatedAt }} repoName="o/r" ci="failure" onOpen={() => {}} />);
    expect(screen.getByText('o/r')).toHaveClass('font-mono');
    expect(screen.getByText('#4')).toBeInTheDocument();
    expect(screen.getByText('CI failure')).toHaveClass('text-danger');
    expect(screen.getByText('3h')).toBeInTheDocument();
  });
});
