import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type OperatorAction } from '@/lib/api';
import { OperatorActionsList } from './operator-actions';

const action = (over: Partial<OperatorAction>): OperatorAction => ({
  kind: 'env', when: 'before_deploy', instruction: 'Generate a key', name: null, where: null, required: true, doneAt: null, doneById: null, ...over,
});

describe('OperatorActionsList', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders nothing without actions', () => {
    const { container } = render(<OperatorActionsList job={{ id: 'j', operatorActions: [] }} onChanged={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('groups by before/after deploy and shows the details', () => {
    render(
      <OperatorActionsList
        job={{ id: 'j', operatorActions: [action({ when: 'after_deploy', kind: 'cli', instruction: 'Run the backfill', required: false }), action({ name: 'SOME_KEY', where: 'apiEnv' })] }}
        onChanged={() => {}}
      />,
    );
    const headings = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    expect(headings).toEqual(['Before deploy', 'After deploy']);
    expect(screen.getByText('SOME_KEY')).toBeInTheDocument();
    expect(screen.getByText('in apiEnv')).toBeInTheDocument();
    expect(screen.getByText('optional')).toBeInTheDocument();
  });

  it('marks the action at its index in the run list done, then refreshes', async () => {
    const mark = vi.spyOn(api, 'markOperatorActionDone').mockResolvedValue({} as never);
    const onChanged = vi.fn();
    render(
      <OperatorActionsList
        job={{ id: 'j', operatorActions: [action({ when: 'after_deploy', instruction: 'Later' }), action({ instruction: 'First' })] }}
        onChanged={onChanged}
      />,
    );
    const row = screen.getByText('First').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mark).toHaveBeenCalledWith('j', 1);
  });

  it('shows done actions without a button, and explains a refused request', async () => {
    vi.spyOn(api, 'markOperatorActionDone').mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    render(<OperatorActionsList job={{ id: 'j', operatorActions: [action({ doneAt: '2026-01-01T00:00:00.000Z' }), action({ instruction: 'Open one' })] }} onChanged={() => {}} />);
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Mark done' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only a signed-in person');
  });
});
