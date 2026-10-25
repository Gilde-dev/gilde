import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from './sidebar';
import { PauseToggle } from './pause-toggle';
import type { Repo } from '@/lib/api';

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

describe('Sidebar repo pause', () => {
  it('shows pausedReason and a resume toggle for paused repos', () => {
    const repos = [{ id: 'r', fullName: 'o/r', paused: true, pausedReason: 'CI broken', stacks: [], testCommands: [] } as unknown as Repo];
    render(<Sidebar projects={[]} projectId={null} repos={repos} onSelectProject={() => {}} />);
    expect(screen.getByText('CI broken')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume o/r' })).toBeInTheDocument();
  });
});
