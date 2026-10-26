import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Repo } from '@/lib/api';
import { RepoDialog } from './repo-dialog';

afterEach(() => vi.restoreAllMocks());

const repo = {
  id: 'r1', fullName: 'o/api', defaultBranch: 'main', routineFireUrl: null, routineTokenEnv: null, maxConcurrentJobs: 1,
} as Repo;

describe('RepoDialog', () => {
  it('validates the env var name, explains it and has no token field', () => {
    render(<RepoDialog open projectId="p1" repo={repo} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText(/NAME of an environment variable on the API server/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^(routine )?token$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Routine token env var name'), { target: { value: 'bad-name' } });
    expect(screen.getByText(/UPPER_SNAKE_CASE/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('sends the right PATCH body when editing', async () => {
    const update = vi.spyOn(api, 'updateRepo').mockResolvedValue(repo);
    const onSaved = vi.fn();
    render(<RepoDialog open projectId="p1" repo={repo} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Default branch'), { target: { value: 'develop' } });
    fireEvent.change(screen.getByLabelText('Routine fire URL'), { target: { value: 'https://example.com/fire' } });
    fireEvent.change(screen.getByLabelText('Routine token env var name'), { target: { value: 'ROUTINE_TOKEN_API' } });
    fireEvent.change(screen.getByLabelText('Max concurrent jobs'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith('r1', {
      defaultBranch: 'develop',
      maxConcurrentJobs: 3,
      routineFireUrl: 'https://example.com/fire',
      routineTokenEnv: 'ROUTINE_TOKEN_API',
    });
  });

  it('adds a repo with its full name', async () => {
    const create = vi.spyOn(api, 'createRepo').mockResolvedValue(repo);
    render(<RepoDialog open projectId="p1" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'o/web' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add repo' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('p1', { fullName: 'o/web', defaultBranch: 'main', maxConcurrentJobs: 1 }));
  });
});
