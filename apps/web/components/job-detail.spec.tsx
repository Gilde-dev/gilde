import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, type Job, type JobDetail, type Repo, type Revision } from '@/lib/api';
import { agentTotals, noAgentUsage } from './agent-usage.fixture';
import { JobDetailView, buildTimeline } from './job-detail';

vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'j1' }) }));

const base: Job = {
  id: 'j1', projectId: 'p', repoId: 'r', featureId: 'f1', title: 'Add thing', task: 'Line one\nLine two',
  acceptanceCriteria: ['It works', 'It is tested'], status: 'awaiting_review', attempts: 1,
  queuedAt: '2026-01-01T00:05:00.000Z', prNumber: 5, prUrl: 'https://github.com/o/r/pull/5', branch: 'claude/gilde-j1',
  lastReason: null, needsApproval: false, approvalReason: null, dependsOn: ['d1'],
  blockedBy: [{ id: 'd1', title: 'Dep job', status: 'pr_open' }], pendingRevisions: 1, revision: 0,
  createdBy: { id: 'u', name: 'Ada' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z',
};

const detail: JobDetail = {
  ...base,
  agentUsage: noAgentUsage,
  feedback: [
    { id: 'fb1', jobId: 'j1', projectId: 'p', repoId: 'r', prNumber: 5, kind: 'review', githubId: '9', author: 'bob', authorAssociation: 'OWNER', state: 'CHANGES_REQUESTED', reviewId: '9', path: null, line: null, body: 'Please fix', url: 'https://x/1', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'fb2', jobId: 'j1', projectId: 'p', repoId: 'r', prNumber: 5, kind: 'review_comment', githubId: '10', author: 'bob', authorAssociation: 'OWNER', state: null, reviewId: '9', path: 'src/a.ts', line: 12, body: 'Rename this', url: 'https://x/2', createdAt: '2026-01-02T00:00:01.000Z' },
  ],
  runs: [{
    id: 'run1', jobId: 'j1', projectId: 'p', repoId: 'r', attempt: 1, status: 'ci_passed', sessionId: 's',
    sessionUrl: 'https://claude.ai/code/s', instructionsVersion: null, error: null, ciConclusion: 'success',
    result: { outcome: 'done', summary: 'All good' }, retro: '- stuff',
    firedAt: '2026-01-01T00:10:00.000Z', finishedAt: '2026-01-01T00:12:05.000Z',
    createdAt: '2026-01-01T00:09:00.000Z', updatedAt: '2026-01-01T00:12:05.000Z',
    agentUsage: noAgentUsage,
  }],
};

const proposed: Revision = {
  id: 'rev1', jobId: 'j1', revision: null, title: null, task: 'New task', acceptanceCriteria: null, dependsOn: null,
  reason: 'Scope changed', sourceRunId: 'run1', status: 'proposed', decidedAt: null, createdAt: '2026-01-02T12:00:00.000Z',
  job: { id: 'j1', title: 'Add thing', task: 't', acceptanceCriteria: [], dependsOn: [], status: 'awaiting_review' }, pr: null,
};

beforeEach(() => {
  vi.spyOn(api, 'getJob').mockResolvedValue(detail);
  vi.spyOn(api, 'listJobRevisions').mockResolvedValue([proposed]);
  vi.spyOn(api, 'listRepos').mockResolvedValue([{ id: 'r', fullName: 'o/repo' } as Repo]);
  vi.spyOn(api, 'listJobs').mockResolvedValue([{ ...base, id: 'x1', title: 'Downstream', dependsOn: ['j1'], status: 'queued' }]);
  vi.spyOn(api, 'getFeature').mockResolvedValue({ id: 'f1', title: 'Checkout flow' } as never);
  vi.spyOn(api, 'getJobPrompt').mockResolvedValue({ text: 'the prompt', instructionsVersion: 'v1', length: 10, limit: 60_000, trimmed: null });
});
afterEach(() => vi.restoreAllMocks());

describe('JobDetailView', () => {
  it('renders header, tabs and timeline', async () => {
    render(<JobDetailView />);
    expect(await screen.findByRole('heading', { name: 'Add thing' })).toBeInTheDocument();
    expect(screen.getByText('Awaiting review')).toBeInTheDocument();
    expect(await screen.findByText('o/repo')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Checkout flow' })).toHaveAttribute('href', '/features/f1?project=p');
    expect(screen.getByRole('link', { name: 'PR #5' })).toHaveAttribute('href', base.prUrl);
    expect(screen.getByText('CI success')).toBeInTheDocument();
    for (const t of ['Overview', /Runs/, /Revisions/, /Feedback/, 'Prompt']) {
      expect(screen.getByRole('tab', { name: t })).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: 'Dep job' })).toHaveAttribute('href', '/jobs/d1?project=p');
    expect(await screen.findByRole('link', { name: 'Downstream' })).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);

    const items = screen.getByRole('heading', { name: 'Timeline' }).closest('div')!.parentElement!.querySelectorAll('li');
    expect(items.length).toBeGreaterThan(4);
    expect(items[0]).toHaveTextContent('Revision proposed: Scope changed');
    expect(items[items.length - 1]).toHaveTextContent('Created by Ada');
    expect(items[0].querySelector('time')).toHaveAttribute('title');
  });

  it('shows runs and feedback grouped per review', async () => {
    render(<JobDetailView />);
    fireEvent.click(await screen.findByRole('tab', { name: /Runs/ }));
    expect(screen.getByText('All good')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Session' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Feedback/ }));
    expect(screen.getByText('Rename this')).toBeInTheDocument();
    expect(screen.getByText('src/a.ts:12')).toBeInTheDocument();
  });

  it('accepts a proposed revision and refreshes', async () => {
    const accept = vi.spyOn(api, 'acceptRevision').mockResolvedValue(proposed);
    render(<JobDetailView />);
    fireEvent.click(await screen.findByRole('tab', { name: /Revisions/ }));
    const calls = vi.mocked(api.listJobRevisions).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith('rev1'));
    await waitFor(() => expect(vi.mocked(api.listJobRevisions).mock.calls.length).toBeGreaterThan(calls));
  });

  it('copies the prompt', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<JobDetailView />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Prompt' }));
    expect(await screen.findByText('the prompt')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('the prompt'));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  describe('prompt tab', () => {
    const open = async () => {
      render(<JobDetailView />);
      fireEvent.click(await screen.findByRole('tab', { name: 'Prompt' }));
    };

    it('shows size against the limit and that nothing was trimmed', async () => {
      await open();
      expect(await screen.findByText('10 of 60,000 characters')).toBeInTheDocument();
      expect(screen.getByText('Nothing trimmed.')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('lists what was trimmed', async () => {
      vi.mocked(api.getJobPrompt).mockResolvedValue({
        text: 'p', instructionsVersion: null, length: 59_900, limit: 60_000,
        trimmed: { lessonsRemoved: ['l1', 'l2'], downstreamTaskCap: 'title-only', downstreamRemoved: ['d1'], downstreamOmitted: 3, featureSpecCap: 4000 },
      });
      await open();
      expect(await screen.findByText('Trimmed to fit the limit')).toBeInTheDocument();
      for (const line of ['2 lessons left out', 'Downstream task text left out (titles, criteria and dependencies kept)', '1 downstream job removed to fit', '3 downstream jobs beyond the first 20 left out', 'Feature spec cut to 4,000 characters']) {
        expect(screen.getByText(line)).toBeInTheDocument();
      }
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('warns when the prompt is over the limit after trimming, and still offers the text', async () => {
      vi.mocked(api.getJobPrompt).mockResolvedValue({ text: 'huge prompt', instructionsVersion: null, length: 61_000, limit: 60_000, trimmed: { downstreamTaskCap: 400 } });
      await open();
      expect(await screen.findByRole('alert')).toHaveTextContent('1,000 characters over the limit');
      expect(screen.getByText('Downstream tasks cut to 400 characters')).toBeInTheDocument();
      expect(screen.getByText('huge prompt')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    });

    it('shows loading and error states', async () => {
      vi.mocked(api.getJobPrompt).mockReturnValue(new Promise(() => undefined));
      await open();
      expect(await screen.findByText('Loading…')).toBeInTheDocument();
    });

    it('shows the error when the prompt cannot be loaded', async () => {
      vi.mocked(api.getJobPrompt).mockRejectedValue(new ApiError('Agent instructions file is unreadable', 400));
      await open();
      expect(await screen.findByRole('alert')).toHaveTextContent('Agent instructions file is unreadable');
    });
  });

  it('shows an empty state for an unknown job', async () => {
    vi.mocked(api.getJob).mockRejectedValue(new ApiError('nope', 404));
    render(<JobDetailView />);
    expect(await screen.findByText('Job not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the board' })).toHaveAttribute('href', '/');
  });
});

describe('buildTimeline', () => {
  it('sorts newest first', () => {
    const t = buildTimeline(detail, [proposed]);
    expect(t.map((e) => e.at)).toEqual([...t.map((e) => e.at)].sort().reverse());
  });

  it('shows per-attempt and total agent usage as estimated, with unknown and partial cost', async () => {
    const run = detail.runs[0];
    vi.spyOn(api, 'getJob').mockResolvedValue({
      ...detail,
      agentUsage: agentTotals({ uncachedInputTokens: 30, cachedInputTokens: 200, cacheCreationTokens: 40, outputTokens: 10, runs: 3, costUsd: 0.5, costPartial: true, costUnknownRequests: 1 }),
      runs: [
        { ...run, agentUsage: agentTotals({ uncachedInputTokens: 10, cachedInputTokens: 100, cacheCreationTokens: 20, outputTokens: 5, runs: 2, costUsd: 0.5, costPartial: true, costUnknownRequests: 1 }) },
        { ...run, id: 'run2', attempt: 2, agentUsage: agentTotals({ outputTokens: 0, runs: 1, costUsd: 0 }) },
        { ...run, id: 'run3', attempt: 3, agentUsage: agentTotals({ outputTokens: 7, runs: 1, costUsd: null, costUnknownRequests: 1 }) },
        { ...run, id: 'run4', attempt: 4, agentUsage: noAgentUsage },
      ],
    });
    render(<JobDetailView />);
    fireEvent.click(await screen.findByRole('tab', { name: /Runs/ }));
    const total = await screen.findByRole('region', { name: 'Total usage, all attempts (Claude Code)' });
    expect(total).toHaveTextContent('280 tokens');
    expect(total).toHaveTextContent('3 requests');
    expect(total).toHaveTextContent('estimated cost $0.5000+ (1 requests unknown)');
    expect(screen.getByRole('region', { name: 'Attempt 1 usage (Claude Code)' })).toHaveTextContent('135 tokens');
    expect(screen.getByRole('region', { name: 'Attempt 2 usage (Claude Code)' })).toHaveTextContent('estimated cost $0.0000');
    expect(screen.getByRole('region', { name: 'Attempt 3 usage (Claude Code)' })).toHaveTextContent('estimated cost unavailable');
    expect(screen.getByText('Attempt 4 usage (Claude Code): no Claude Code telemetry received yet.')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Session' })).toHaveLength(4);
  });
});
