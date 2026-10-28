import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, JOB_STATUSES, type Job, type JobStatus } from '@/lib/api';
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
