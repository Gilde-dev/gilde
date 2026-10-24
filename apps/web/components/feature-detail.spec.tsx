import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type FeatureDetail, type Job, type Repo } from '@/lib/api';
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
    ...over,
  };
  vi.spyOn(api, 'getFeature').mockResolvedValue(detail);
  vi.spyOn(api, 'listRepos').mockResolvedValue([{ id: 'r1', fullName: 'o/repo' } as Repo]);
  vi.spyOn(api, 'listJobs').mockResolvedValue([]);
  render(<FeatureDetailView />);
}

describe('FeatureDetailView', () => {
  it('shows the spec, criteria and jobs grouped by status with repo name', async () => {
    setup();
    const spec = await screen.findByText(/Line one/);
    expect(spec.tagName).toBe('PRE');
    expect(spec).toHaveClass('whitespace-pre-wrap');
    expect(screen.getByText('It works')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'triage (1)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'merged (1)' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('o/repo')).toHaveLength(2));
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
});
