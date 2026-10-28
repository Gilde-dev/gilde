import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, JOB_STATUSES, type Job, type JobStatus, type JobSyncResult } from '@/lib/api';
import { describeSync } from '@/lib/job-actions';
import { JobActions } from './job-actions';

const job = (status: JobStatus) => ({ id: 'j1', status }) as Job;

afterEach(() => vi.restoreAllMocks());

describe('JobActions', () => {
  it.each(JOB_STATUSES)('shows the right buttons for %s', (status) => {
    render(<JobActions job={job(status)} onChanged={() => {}} />);
    const cancel = ['triage', 'queued', 'dispatched', 'parked'].includes(status);
    expect(!!screen.queryByRole('button', { name: 'Cancel' })).toBe(cancel);
    expect(!!screen.queryByRole('button', { name: 'Retry' })).toBe(status === 'parked');
    expect(!!screen.queryByRole('button', { name: 'Send back to agent' })).toBe(status === 'pr_open' || status === 'awaiting_review');
    expect(!!screen.queryByRole('button', { name: 'Queue' })).toBe(status === 'triage');
    expect(!!screen.queryByRole('button', { name: 'Back to triage' })).toBe(status === 'queued');
  });

  it('asks for confirmation before cancelling, then refreshes', async () => {
    const cancel = vi.spyOn(api, 'cancelJob').mockResolvedValue({} as Job);
    const onChanged = vi.fn();
    render(<JobActions job={job('queued')} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancel' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(cancel).toHaveBeenCalledWith('j1');
  });

  it('can back out of the confirm step', () => {
    render(<JobActions job={job('queued')} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('retries a parked job and shows API errors', async () => {
    const retry = vi.spyOn(api, 'retryJob').mockRejectedValue(new ApiError('long', 409, 'Job is not parked'));
    const onChanged = vi.fn();
    render(<JobActions job={job('parked')} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Job is not parked');
    expect(retry).toHaveBeenCalledWith('j1');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('sends an awaiting_review job back with a reason', async () => {
    const sendBack = vi.spyOn(api, 'sendBackJob').mockResolvedValue({} as Job);
    const onChanged = vi.fn();
    render(<JobActions job={job('awaiting_review')} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send back to agent' }));
    const submit = screen.getByRole('button', { name: 'Send back' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: ' fix the tests ' } });
    fireEvent.click(submit);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(sendBack).toHaveBeenCalledWith('j1', 'fix the tests');
  });

  it('shows the API error inside the send-back dialog', async () => {
    vi.spyOn(api, 'sendBackJob').mockRejectedValue(new ApiError('long', 409, 'Cannot send back'));
    render(<JobActions job={job('pr_open')} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send back to agent' }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot send back');
  });

  it('queues a triage job and reports dependency warnings', async () => {
    const enqueue = vi.spyOn(api, 'enqueueJob').mockResolvedValue({
      title: 'Job', warnings: [{ dependencyId: 'd', message: 'Depends on "X", which is still in triage' }],
    } as never);
    const onChanged = vi.fn();
    const onEnqueued = vi.fn();
    render(<JobActions job={job('triage')} onChanged={onChanged} onEnqueued={onEnqueued} />);
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(enqueue).toHaveBeenCalledWith('j1');
    expect(onEnqueued).toHaveBeenCalledWith(['Job: Depends on "X", which is still in triage']);
  });

  it('sends a queued job back to triage', async () => {
    const triage = vi.spyOn(api, 'triageJob').mockResolvedValue({} as Job);
    const onChanged = vi.fn();
    render(<JobActions job={job('queued')} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to triage' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(triage).toHaveBeenCalledWith('j1');
  });
});

describe('JobActions recreate', () => {
  const blocked = { id: 'j1', projectId: 'p1', status: 'merged', mergedBlocked: true, replacedById: null } as Job;

  it('offers Recreate job only for merged-without-work jobs without a replacement', () => {
    const { rerender } = render(<JobActions job={blocked} onChanged={() => {}} />);
    expect(screen.getByRole('button', { name: 'Recreate job' })).toBeInTheDocument();
    rerender(<JobActions job={{ ...blocked, mergedBlocked: false }} onChanged={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Recreate job' })).toBeNull();
    rerender(<JobActions job={{ ...blocked, status: 'parked' }} onChanged={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Recreate job' })).toBeNull();
    rerender(<JobActions job={{ ...blocked, replacedById: 'j2' }} onChanged={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Recreate job' })).toBeNull();
    expect(screen.getByRole('link', { name: 'View replacement job' })).toHaveAttribute('href', '/jobs/j2?project=p1');
  });

  it('explains the effect and makes no request when cancelled', () => {
    const recreate = vi.spyOn(api, 'recreateJob').mockResolvedValue({} as Job);
    render(<JobActions job={blocked} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recreate job' }));
    expect(screen.getByText(/new job in triage/)).toHaveTextContent(/depend on this one will wait for the new job/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(recreate).not.toHaveBeenCalled();
  });

  it('creates once (pending blocks a second click), refreshes and links to the replacement', async () => {
    let resolve!: (j: Job) => void;
    const recreate = vi.spyOn(api, 'recreateJob').mockReturnValue(new Promise<Job>((r) => (resolve = r)));
    const onChanged = vi.fn();
    render(<JobActions job={blocked} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recreate job' }));
    const confirm = screen.getAllByRole('button', { name: 'Recreate job' }).at(-1)!;
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(confirm).toBeDisabled();
    expect(recreate).toHaveBeenCalledTimes(1);
    resolve({ id: 'j9' } as Job);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(recreate).toHaveBeenCalledWith('j1');
    expect(await screen.findByRole('link', { name: 'View replacement job' })).toHaveAttribute('href', '/jobs/j9?project=p1');
  });

  it('shows the failure and keeps the dialog open', async () => {
    vi.spyOn(api, 'recreateJob').mockRejectedValue(new ApiError('long', 409, 'The job changed in the meantime'));
    const onChanged = vi.fn();
    render(<JobActions job={blocked} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recreate job' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Recreate job' }).at(-1)!);
    expect(await screen.findByRole('alert')).toHaveTextContent('The job changed in the meantime');
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('JobActions sync from GitHub', () => {
  const synced = (over: Partial<JobSyncResult> = {}): JobSyncResult => ({
    jobId: 'j1',
    pr: { number: 130, state: 'open', merged: false, headSha: 'abc' },
    ciConclusion: null,
    before: { status: 'pr_open', prNumber: 130, headSha: 'abc', needsApproval: false },
    after: { status: 'pr_open', prNumber: 130, headSha: 'abc', needsApproval: false },
    changes: [],
    ...over,
  });
  const withPr = (status: JobStatus, prNumber: number | null = 130) => ({ id: 'j1', status, prNumber }) as Job;

  it.each([
    ['dispatched', null, true],
    ['pr_open', 130, true],
    ['awaiting_review', 130, true],
    ['parked', 130, true],
    ['parked', null, false],
    ['merged', 130, true],
    ['merged', null, false],
    ['rejected', 130, true],
    ['rejected', null, false],
    ['triage', null, false],
    ['queued', 130, false],
    ['cancelled', 130, false],
  ] as const)('%s with PR %s: sync offered=%s', (status, pr, offered) => {
    render(<JobActions job={withPr(status, pr)} showSync onChanged={() => {}} />);
    expect(!!screen.queryByRole('button', { name: 'Sync from GitHub' })).toBe(offered);
  });

  it('is not offered unless the view asks for it (board cards)', () => {
    render(<JobActions job={withPr('pr_open')} onChanged={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Sync from GitHub' })).toBeNull();
  });

  it('is busy while running, refreshes and reports a move', async () => {
    let resolve!: (r: JobSyncResult) => void;
    const sync = vi.spyOn(api, 'syncJob').mockReturnValue(new Promise((r) => (resolve = r)));
    const onChanged = vi.fn();
    render(<JobActions job={withPr('awaiting_review')} showSync onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sync from GitHub' }));
    const busy = screen.getByRole('button', { name: 'Checking GitHub…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    resolve(synced({
      pr: { number: 130, state: 'closed', merged: true, headSha: 'abc' },
      after: { status: 'merged', prNumber: 130, headSha: 'abc', needsApproval: false },
      changes: ['PR #130 merged'],
    }));
    expect(await screen.findByRole('status')).toHaveTextContent('PR #130 is merged: moved to merged');
    expect(sync).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('says nothing changed with the CI state, and handles no PR', async () => {
    const sync = vi.spyOn(api, 'syncJob').mockResolvedValueOnce(synced());
    render(<JobActions job={withPr('pr_open')} showSync onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sync from GitHub' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Nothing changed: PR #130 is open, CI pending');
    sync.mockResolvedValueOnce(synced({ pr: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Sync from GitHub' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No PR found on GitHub'));
  });

  it('reports a CI-only refresh accurately', () => {
    expect(describeSync(synced({ ciConclusion: 'success', changes: ['CI success recorded for the latest run'] }))).toBe(
      'PR #130 is open: CI success recorded for the latest run',
    );
  });

  it('shows the safe 502 reason and a clean 403 message', async () => {
    const sync = vi.spyOn(api, 'syncJob').mockRejectedValueOnce(new ApiError('x', 502, 'Cannot read o/r on GitHub: not found (404)'));
    render(<JobActions job={withPr('pr_open')} showSync onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sync from GitHub' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot read o/r on GitHub: not found (404)');
    sync.mockRejectedValueOnce(new ApiError('x', 403, 'A verified human is required'));
    fireEvent.click(screen.getByRole('button', { name: 'Sync from GitHub' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Only a signed-in person can sync jobs from GitHub'));
  });
});
