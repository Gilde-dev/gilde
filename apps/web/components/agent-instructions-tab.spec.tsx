import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type AgentInstruction, type AgentInstructions } from '@/lib/api';
import { AgentInstructionsTab, textDiff } from './agent-instructions-tab';

afterEach(() => vi.restoreAllMocks());

const WHO = { id: 'u1', name: 'Ada', email: 'ada@example.com' };
const item = (agentId: AgentInstruction['agentId'], over: Partial<AgentInstruction> = {}): AgentInstruction => ({ agentId, text: '', version: 0, updatedAt: null, updatedBy: null, ...over });
const instructions = (over: Partial<AgentInstructions> = {}): AgentInstructions => ({
  projectId: 'p1', maxChars: 100,
  agents: [item('gilde', { text: 'Focus on checkout.', version: 2, updatedAt: '2026-11-01T10:00:00.000Z', updatedBy: WHO }), item('verkenner'), item('verfijner'), item('werkmeester'), item('reviewer')],
  ...over,
});
const me = (isAdmin: boolean) => vi.spyOn(api, 'me').mockResolvedValue({ id: 'u1', name: 'Ada', email: 'ada@example.com', isAdmin } as never);

describe('textDiff', () => {
  it('marks removed and added lines as plain text', () => {
    expect(textDiff('a\nb\nc', 'a\nx\nc')).toBe('  a\n- b\n+ x\n  c');
    expect(textDiff('', 'new')).toBe('+ new');
    expect(textDiff('old', '')).toBe('- old');
  });
});

describe('AgentInstructionsTab', () => {
  it('shows one textarea per agent with the character count and limit, editable by admins', async () => {
    vi.spyOn(api, 'getAgentInstructions').mockResolvedValue(instructions());
    me(true);
    render(<AgentInstructionsTab projectId="p1" />);
    expect(await screen.findByLabelText('Additional instructions for Co-pilot')).toHaveValue('Focus on checkout.');
    for (const label of ['Co-pilot', 'Verkenner', 'Verfijner', 'Werkmeester', 'Reviewer']) expect(screen.getByLabelText(`Additional instructions for ${label}`)).toBeInTheDocument();
    expect(screen.queryByText(/Coding agents$/)).toBeNull();
    expect(screen.getByLabelText('Co-pilot character count')).toHaveTextContent('18 / 100 characters');
    expect(screen.getByText('Version 2')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^(Save|Remove addition)$/ }).length).toBeGreaterThan(0));
  });

  it('is read-only for non-admins', async () => {
    vi.spyOn(api, 'getAgentInstructions').mockResolvedValue(instructions());
    me(false);
    render(<AgentInstructionsTab projectId="p1" />);
    expect(await screen.findByText('Only admins can change agent instructions.')).toBeInTheDocument();
    expect(screen.getByLabelText('Additional instructions for Co-pilot')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove addition' })).toBeNull();
  });

  it('saves a change, blocks text over the limit and sends empty text to remove an addition', async () => {
    vi.spyOn(api, 'getAgentInstructions').mockResolvedValue(instructions());
    me(true);
    const save = vi.spyOn(api, 'replaceAgentInstruction').mockResolvedValue(item('verkenner', { text: 'New', version: 1, updatedAt: '2026-11-02T10:00:00.000Z', updatedBy: WHO }));
    render(<AgentInstructionsTab projectId="p1" />);
    const form = within(await screen.findByRole('form', { name: 'Verkenner instructions' }));
    const box = form.getByLabelText('Additional instructions for Verkenner');
    await waitFor(() => expect(form.getByRole('button', { name: 'Save' })).toBeDisabled());
    fireEvent.change(box, { target: { value: 'x'.repeat(101) } });
    expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(box, { target: { value: 'New' } });
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('p1', 'verkenner', 'New'));

    const copilot = within(screen.getByRole('form', { name: 'Co-pilot instructions' }));
    fireEvent.change(copilot.getByLabelText('Additional instructions for Co-pilot'), { target: { value: '' } });
    fireEvent.click(copilot.getByRole('button', { name: 'Remove addition' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('p1', 'gilde', ''));
  });

  it('shows the zod issue of a rejected save', async () => {
    vi.spyOn(api, 'getAgentInstructions').mockResolvedValue(instructions());
    me(true);
    vi.spyOn(api, 'replaceAgentInstruction').mockRejectedValue(new ApiError('Validation failed', 400, 'Validation failed', [{ path: 'text', message: 'At most 100 characters (now 101)' }]));
    render(<AgentInstructionsTab projectId="p1" />);
    const form = within(await screen.findByRole('form', { name: 'Reviewer instructions' }));
    fireEvent.change(form.getByLabelText('Additional instructions for Reviewer'), { target: { value: 'ok' } });
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    expect(await form.findByText('At most 100 characters (now 101)')).toBeInTheDocument();
  });

  it('shows the version history with diffs as plain text', async () => {
    vi.spyOn(api, 'getAgentInstructions').mockResolvedValue(instructions());
    me(true);
    vi.spyOn(api, 'getAgentInstructionHistory').mockResolvedValue([
      { version: 2, text: 'Focus on <b>checkout</b>.', current: true, updatedAt: '2026-11-01T10:00:00.000Z', updatedBy: WHO },
      { version: 1, text: 'Old', current: false, updatedAt: '2026-10-30T10:00:00.000Z', updatedBy: WHO },
    ]);
    const { container } = render(<AgentInstructionsTab projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Version history\s*of Co-pilot/ }));
    const list = await screen.findByRole('list', { name: 'Co-pilot version history' });
    expect(within(list).getByLabelText('Changes in version 2')).toHaveTextContent('- Old');
    expect(within(list).getByLabelText('Changes in version 2')).toHaveTextContent('+ Focus on <b>checkout</b>.');
    expect(within(list).getByLabelText('Changes in version 1')).toHaveTextContent('+ Old');
    expect(within(list).getByText('Current')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
  });

  it('shows a load error with retry', async () => {
    vi.spyOn(api, 'getAgentInstructions').mockRejectedValue(new ApiError('boom', 500, 'boom'));
    me(true);
    render(<AgentInstructionsTab projectId="p1" />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
