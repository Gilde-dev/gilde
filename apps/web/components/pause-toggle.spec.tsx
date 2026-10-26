import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PauseToggle } from './pause-toggle';

describe('PauseToggle', () => {
  it('pauses a running target and refreshes', async () => {
    const toggle = vi.fn().mockResolvedValue({});
    const onChanged = vi.fn();
    render(<PauseToggle paused={false} label="x" toggle={toggle} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause x' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(toggle).toHaveBeenCalledWith(true);
  });

  it('resumes a paused target', async () => {
    const toggle = vi.fn().mockResolvedValue({});
    render(<PauseToggle paused label="x" toggle={toggle} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume x' }));
    await waitFor(() => expect(toggle).toHaveBeenCalledWith(false));
  });

  it('shows the error when toggling fails', async () => {
    render(<PauseToggle paused={false} label="x" toggle={() => Promise.reject(new Error('nope'))} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause x' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });
});
