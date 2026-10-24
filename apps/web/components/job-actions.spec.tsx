import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, JOB_STATUSES, type Job, type JobStatus } from '@/lib/api';
import { JobActions } from './job-actions';

const job = (status: JobStatus) => ({ id: 'j1', status }) as Job;

afterEach(() => vi.restoreAllMocks());

describe('JobActions', () => {
  it.each(JOB_STATUSES)('shows the right buttons for %s', (status) => {
    render(<JobActions job={job(status)} onChanged={() => {}} />);
    const cancel = ['queued', 'dispatched', 'parked'].includes(status);
    expect(!!screen.queryByRole('button', { name: 'Cancel' })).toBe(cancel);
    expect(!!screen.queryByRole('button', { name: 'Retry' })).toBe(status === 'parked');
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
});
