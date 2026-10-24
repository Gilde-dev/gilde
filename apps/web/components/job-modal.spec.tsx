import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Job, type JobDetail } from '@/lib/api';
import { JobModal } from './job-modal';

const base: Job = {
  id: 'j1',
  projectId: 'p',
  repoId: 'r', featureId: null,
  title: 'Add thing',
  task: 'Do the thing',
  acceptanceCriteria: ['It works', 'It is tested'],
  status: 'awaiting_review',
  attempts: 1,
  queuedAt: '2026-01-01T00:00:00.000Z',
  prNumber: 5,
  prUrl: 'https://github.com/o/r/pull/5',
  branch: 'claude/gilde-j1',
  lastReason: null,
    needsApproval: false,
    approvalReason: null,
    dependsOn: [],
    blockedBy: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const detail: JobDetail = {
  ...base,
  feedback: [],
  runs: [
    {
      id: 'run1',
      jobId: 'j1',
      projectId: 'p',
      repoId: 'r',
      attempt: 1,
      status: 'ci_passed',
      sessionId: 's',
      sessionUrl: 'https://claude.ai/code/s',
      error: null,
      ciConclusion: 'success',
      result: { outcome: 'done', summary: 'All good' },
      retro: '- What I changed: stuff',
      firedAt: null,
      finishedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe('JobModal', () => {
  it('shows the job and its runs with session link and retro', async () => {
    vi.spyOn(api, 'getJob').mockResolvedValue(detail);
    render(<JobModal job={base} onClose={() => {}} />);

    expect(screen.getByText('Add thing')).toBeInTheDocument();
    expect(screen.getByText('Do the thing')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByText('claude/gilde-j1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PR #5' })).toHaveAttribute('href', base.prUrl);

    await waitFor(() => expect(screen.getByText('All good')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Session' })).toHaveAttribute('href', 'https://claude.ai/code/s');
    expect(screen.getByText('CI success')).toBeInTheDocument();
    expect(screen.getByText('done')).toBeInTheDocument();
    expect(screen.getByText('Retro').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('- What I changed: stuff')).toBeInTheDocument();
  });

  it('renders nothing when no job is selected', () => {
    render(<JobModal job={null} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
