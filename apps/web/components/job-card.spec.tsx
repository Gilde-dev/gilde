import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Job } from '@/lib/api';
import { JobCard } from './job-card';

const base = {
  id: 'j', projectId: 'p', repoId: 'r', title: 'Job', task: 't', acceptanceCriteria: [], status: 'queued',
  attempts: 0, queuedAt: '2026-01-01T00:00:00.000Z', prNumber: null, prUrl: null, branch: null, lastReason: null,
  needsApproval: false, approvalReason: null, dependsOn: [], blockedBy: [],
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
