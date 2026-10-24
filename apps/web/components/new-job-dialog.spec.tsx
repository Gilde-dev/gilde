import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Job, type Repo } from '@/lib/api';
import { NewJobDialog } from './new-job-dialog';

const repoA = { id: 'ra', fullName: 'o/a' } as Repo;
const repoB = { id: 'rb', fullName: 'o/b' } as Repo;

afterEach(() => vi.restoreAllMocks());

function setup(repos: Repo[] = [repoA]) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(<NewJobDialog open repos={repos} onClose={onClose} onCreated={onCreated} />);
  return { onClose, onCreated };
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('NewJobDialog', () => {
  it('preselects the only repo and leaves the choice open with several', () => {
    setup([repoA]);
    expect(screen.getByLabelText('Repo')).toHaveValue('ra');
  });

  it('requires a repo choice when there are several', () => {
    setup([repoA, repoB]);
    expect(screen.getByLabelText('Repo')).toHaveValue('');
  });

  it('adds and removes criteria rows', () => {
    setup();
    expect(screen.getAllByLabelText(/^Criterion \d$/)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Add criterion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add criterion' }));
    expect(screen.getAllByLabelText(/^Criterion \d$/)).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Remove criterion 2' }));
    expect(screen.getAllByLabelText(/^Criterion \d$/)).toHaveLength(2);
  });

  it('drops empty criteria, submits, closes and refreshes on success', async () => {
    const create = vi.spyOn(api, 'createJob').mockResolvedValue({} as Job);
    const { onClose, onCreated } = setup();
    type('Title', 'My title');
    type('Task', 'Do the whole task');
    fireEvent.click(screen.getByRole('button', { name: 'Add criterion' }));
    type('Criterion 2', '  It works ');
    fireEvent.click(screen.getByRole('button', { name: 'Create job' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith('ra', { title: 'My title', task: 'Do the whole task', acceptanceCriteria: ['It works'] });
    expect(onCreated).toHaveBeenCalled();
  });

  it('shows API validation errors per field and stays open', async () => {
    vi.spyOn(api, 'createJob').mockRejectedValue(
      new ApiError('POST failed: 400 Validation failed', 400, 'Validation failed', [
        { path: 'title', message: 'Too short' },
        { path: 'acceptanceCriteria.0', message: 'Criterion too short' },
      ]),
    );
    const { onClose } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add criterion' }));
    type('Criterion 1', '');
    type('Criterion 2', 'ab');
    fireEvent.click(screen.getByRole('button', { name: 'Create job' }));
    expect(await screen.findByText('Too short')).toBeInTheDocument();
    // index 0 of the submitted list is row 2 of the form
    const row2 = screen.getByLabelText('Criterion 2').closest('li')!;
    expect(row2).toHaveTextContent('Criterion too short');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create job' })).toBeEnabled();
  });

  it('disables submit while saving', async () => {
    let resolve!: (j: Job) => void;
    vi.spyOn(api, 'createJob').mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Create job' }));
    expect(await screen.findByRole('button', { name: 'Creating…' })).toBeDisabled();
    resolve({} as Job);
  });

  it('creates in triage only when the toggle is on', async () => {
    const create = vi.spyOn(api, 'createJob').mockResolvedValue({} as Job);
    setup();
    type('Title', 'A title');
    type('Task', 'Do something useful');
    fireEvent.click(screen.getByRole('button', { name: 'Create job' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][1]).not.toHaveProperty('status');

    fireEvent.click(screen.getByLabelText('Create in triage'));
    type('Title', 'A title');
    type('Task', 'Do something useful');
    fireEvent.click(screen.getByRole('button', { name: 'Create job' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1][1]).toMatchObject({ status: 'triage' });
  });
});
