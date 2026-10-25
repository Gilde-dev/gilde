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
