import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/lib/api';
import { ReconcileNow } from './reconcile-now';

afterEach(() => vi.restoreAllMocks());

describe('ReconcileNow', () => {
  it('reconciles the given project only, with a busy state and its result', async () => {
    let resolve!: (r: { checked: number; corrected: number }) => void;
    const reconcile = vi.spyOn(api, 'reconcileProject').mockReturnValue(new Promise((r) => (resolve = r)));
    const onDone = vi.fn();
    render(<ReconcileNow projectId="p1" onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile now' }));
    expect(screen.getByRole('button', { name: 'Reconciling…' })).toBeDisabled();
    resolve({ checked: 3, corrected: 1 });
    expect(await screen.findByRole('status')).toHaveTextContent('Checked 3 jobs; corrected 1.');
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith('p1');
    expect(onDone).toHaveBeenCalled();
  });

  it('shows a clean message when refused', async () => {
    vi.spyOn(api, 'reconcileProject').mockRejectedValue(new ApiError('x', 403, 'A verified human is required'));
    render(<ReconcileNow projectId="p1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile now' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Only a signed-in person can reconcile a project'));
  });
});
