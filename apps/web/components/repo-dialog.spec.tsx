import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Repo } from '@/lib/api';
import { RepoDialog } from './repo-dialog';

afterEach(() => vi.restoreAllMocks());

const repo = {
  id: 'r1', fullName: 'o/api', defaultBranch: 'main', maxConcurrentJobs: 1,
} as Repo;

describe('RepoDialog', () => {
  it('has no routine or token fields and says capacity comes from personal executors', () => {
    render(<RepoDialog open projectId="p1" repo={repo} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText(/Capacity now comes from personal executors/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Settings > Executors/ })).toHaveAttribute('href', '/settings/executors');
    expect(screen.queryByLabelText(/routine/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();
  });

  it('sends a complete PUT body when editing', async () => {
    const update = vi.spyOn(api, 'replaceRepo').mockResolvedValue(repo);
    const onSaved = vi.fn();
    render(<RepoDialog open projectId="p1" repo={repo} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Default branch'), { target: { value: 'develop' } });
    fireEvent.change(screen.getByLabelText('Max concurrent jobs'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith('r1', { defaultBranch: 'develop', maxConcurrentJobs: 3 });
  });

  it('keeps the loaded branch when the field is blank', async () => {
    const loaded = { ...repo, maxConcurrentJobs: 2 } as Repo;
    const update = vi.spyOn(api, 'replaceRepo').mockResolvedValue(loaded);
    render(<RepoDialog open projectId="p1" repo={loaded} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText('Default branch'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('r1', { defaultBranch: 'main', maxConcurrentJobs: 2 }));
  });

  it('adds a repo with its full name', async () => {
    const create = vi.spyOn(api, 'createRepo').mockResolvedValue(repo);
    render(<RepoDialog open projectId="p1" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'o/web' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add repo' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('p1', { fullName: 'o/web', defaultBranch: 'main', maxConcurrentJobs: 1 }));
  });
});
