import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type FeatureDetail, type Job, type Repo } from '@/lib/api';
import { agentTotals, noAgentUsage } from './agent-usage.fixture';
import { feature } from './feature.fixture';
import { FeatureDetailView } from './feature-detail';

vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'f1' }) }));

afterEach(() => vi.restoreAllMocks());

const job = (id: string, status: Job['status']) =>
  ({ id, repoId: 'r1', featureId: 'f1', title: `Job ${id}`, status, prUrl: null, prNumber: null }) as Job;

function setup(over: Partial<FeatureDetail> = {}) {
  const detail: FeatureDetail = {
    ...feature({ spec: 'Line one\nLine two', acceptanceCriteria: ['It works'] }),
    jobs: [job('a', 'triage'), job('b', 'merged')],
    agentUsage: noAgentUsage,
    ...over,
  };
  vi.spyOn(api, 'getFeature').mockResolvedValue(detail);
  vi.spyOn(api, 'listRepos').mockResolvedValue([{ id: 'r1', fullName: 'o/repo' } as Repo]);
  vi.spyOn(api, 'listJobs').mockResolvedValue([]);
  vi.spyOn(api, 'listRevisions').mockResolvedValue([]);
  render(<FeatureDetailView />);
}

describe('FeatureDetailView', () => {
  it('shows the spec and criteria on the overview tab', async () => {
    setup();
    const spec = await screen.findByText(/Line one/);
    expect(spec).toHaveClass('whitespace-pre-wrap');
    expect(screen.getByText('It works')).toBeInTheDocument();
  });

  it('links the pinned spec version, not the latest draft, and leaves unlinked features alone', async () => {
    setup({ pinnedSpec: {
      specId: 's1', specVersionId: 'v1', version: 2, slug: 'dark-mode', title: 'Dark mode', repoId: 'r1', repoFullName: 'o/repo', path: 'docs/specs/dark-mode.md',
      bodySha256: 'h', approvalId: 'ap', approvedAt: '2026-01-02T00:00:00.000Z', approvedByName: 'Ann', recordingId: 'rec', recordingJobId: 'j', recordingJobTitle: 'Record',
    } });
    expect(await screen.findByRole('link', { name: 'Dark mode v2' })).toHaveAttribute('href', '/specs/s1/versions/2?project=p');
    expect(screen.getByText(/approved by Ann/)).toBeInTheDocument();
  });

  it('shows no pinned spec section for a feature without one', async () => {
    setup();
    await screen.findByText(/Line one/);
    expect(screen.queryByRole('region', { name: 'Pinned spec' })).not.toBeInTheDocument();
  });

  it('lists jobs on the jobs tab in dependency order and toggles to repos', async () => {
    setup({ jobs: [{ ...job('b', 'merged'), dependsOn: ['a'], updatedAt: '2026-01-01T00:00:00.000Z' } as Job, { ...job('a', 'triage'), dependsOn: [] } as Job] });
    fireEvent.click(await screen.findByRole('tab', { name: 'Jobs' }));
    expect(screen.getByRole('heading', { name: '1. No dependencies (1)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '2. After step 1 (1)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Job b' })).toHaveAttribute('href', '/jobs/b?project=p');
    expect(screen.getByText('after Job a')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Repo' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'o/repo (2)' })).toBeInTheDocument());
  });

  it('shows a note for a cycle without crashing', async () => {
    setup({ jobs: [{ ...job('a', 'triage'), dependsOn: ['b'] } as Job, { ...job('b', 'triage'), dependsOn: ['a'] } as Job] });
    fireEvent.click(await screen.findByRole('tab', { name: 'Jobs' }));
    expect(screen.getByRole('note')).toHaveTextContent(/cycle/i);
  });

  it('shows the activity tab', async () => {
    setup({ jobs: [{ ...job('a', 'merged'), prNumber: 5, updatedAt: '2026-01-01T00:00:00.000Z' } as Job] });
    fireEvent.click(await screen.findByRole('tab', { name: 'Activity' }));
    expect(await screen.findByText('PR #5 merged: Job a')).toBeInTheDocument();
  });

  it('shows only the buttons that fit the status', async () => {
    setup({ status: 'draft' });
    await screen.findByRole('button', { name: 'Start' });
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('shows warnings from start', async () => {
    setup({ status: 'draft' });
    vi.spyOn(api, 'startFeature').mockResolvedValue({ ...feature({ status: 'active' }), warnings: [{ dependencyId: 'd', message: 'Depends on "X", which is still in triage' }] });
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByText(/which is still in triage/)).toBeInTheDocument();
  });

  it('lists open jobs after done and left-running jobs after cancel', async () => {
    setup({ status: 'active' });
    vi.spyOn(api, 'doneFeature').mockResolvedValue({ ...feature({ status: 'done' }), openJobs: [{ id: 'x', title: 'Open one', status: 'pr_open' }] });
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Open one (pr_open)')).toBeInTheDocument();
  });

  it('reports jobs left running after cancel', async () => {
    setup({ status: 'active' });
    vi.spyOn(api, 'cancelFeature').mockResolvedValue({
      ...feature({ status: 'cancelled' }),
      cancelledJobs: [{ id: 'c', title: 'Gone', status: 'cancelled' }],
      activeJobs: [{ id: 'x', title: 'Still running', status: 'dispatched' }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Still running (dispatched)')).toBeInTheDocument();
    expect(screen.getByText('Gone (cancelled)')).toBeInTheDocument();
  });

  it('opens the create-job modal with the feature preselected and sends featureId', async () => {
    setup({ status: 'active' });
    const create = vi.spyOn(api, 'createJob').mockResolvedValue({} as Job);
    fireEvent.click(await screen.findByRole('button', { name: 'Add job' }));
    expect(await screen.findByText('Checkout flow', { selector: 'span' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New job title' } });
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'Do the whole task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create job' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][1]).toMatchObject({ featureId: 'f1' });
  });

  it('shows the lifetime feature total from the detail response, labelled estimated', async () => {
    setup({ agentUsage: agentTotals({ uncachedInputTokens: 10, cachedInputTokens: 100, cacheCreationTokens: 20, outputTokens: 5, runs: 3, costUsd: 0.25 }) });
    const usage = await screen.findByRole('region', { name: 'Lifetime usage (Claude Code)' });
    expect(usage).toHaveTextContent('135 tokens');
    expect(usage).toHaveTextContent('3 requests');
    expect(usage).toHaveTextContent('estimated cost $0.2500');
    expect(usage).toHaveTextContent(/notional/);
    expect(usage.querySelector('[title*="estimates"]')).not.toBeNull();
  });

  it('says no telemetry when the feature has no usage', async () => {
    setup();
    expect(await screen.findByText(/no Claude Code telemetry received yet/)).toBeInTheDocument();
  });

  it('shows unavailable (not $0) for unknown cost and $0 for a real zero', async () => {
    setup({ agentUsage: agentTotals({ outputTokens: 5, runs: 1, costUsd: null, costUnknownRequests: 1 }) });
    expect(await screen.findByText('unavailable')).toBeInTheDocument();
  });
});
