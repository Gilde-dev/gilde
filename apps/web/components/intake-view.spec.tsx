import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, type CopilotStatus, type Project } from '@/lib/api';
import { intakeItem } from './intake.fixture';
import { IntakeView } from './intake-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/intake',
  useSearchParams: () => new URLSearchParams(''),
}));

afterEach(() => vi.restoreAllMocks());

const status = (refine: boolean): CopilotStatus => ({ enabled: true, model: 'm', scout: { enabled: false, model: null, disabledReason: null }, refine: { enabled: refine, model: refine ? 'm' : null } });

function setup(items = [intakeItem()], refine = true) {
  vi.spyOn(api, 'listProjects').mockResolvedValue([{ id: 'p', name: 'P' }] as Project[]);
  vi.spyOn(api, 'copilotStatus').mockResolvedValue(status(refine));
  return vi.spyOn(api, 'listIntake').mockResolvedValue(items);
}

describe('IntakeView', () => {
  it('lists items with issue link, repo, status, spec state, open questions, error and age', async () => {
    setup([
      intakeItem({
        status: 'drafted', specId: 's1',
        spec: { id: 's1', slug: 'dark', title: 'Dark mode spec', status: 'draft', currentVersion: 2, approvedVersion: null, openQuestions: 2 },
      }),
      intakeItem({ id: 'i2', number: 13, title: 'Broken', status: 'failed', lastError: 'agent timed out' }),
    ]);
    render(<IntakeView />);
    const link = await screen.findByRole('link', { name: '#12 Add dark mode' });
    expect(link).toHaveAttribute('href', 'https://github.com/o/web/issues/12');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getAllByText('o/web')).toHaveLength(2);
    const list = within(screen.getByRole('list'));
    expect(list.getByText('Drafted')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dark mode spec' })).toHaveAttribute('href', '/specs/s1?project=p');
    expect(screen.getByText('2 open questions')).toBeInTheDocument();
    expect(list.getByText('Draft')).toBeInTheDocument();
    expect(list.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/agent timed out/)).toBeInTheDocument();
    expect(screen.getAllByText(/Opened/)).toHaveLength(2);
  });

  it('shows the status comment link, the answer count and the comment error', async () => {
    setup([
      intakeItem({ statusCommentUrl: 'https://github.com/o/web/issues/12#issuecomment-9', commentCount: 2 }),
      intakeItem({ id: 'i2', number: 13, title: 'No permission', commentError: 'GitHub refused to write the status comment (HTTP 403). The GitHub App needs the Issues: write permission on this repo.' }),
      intakeItem({ id: 'i3', number: 14, title: 'Quiet' }),
    ]);
    render(<IntakeView />);
    await screen.findByRole('link', { name: '#12 Add dark mode' });
    const posted = screen.getByRole('link', { name: 'Status comment posted' });
    expect(posted).toHaveAttribute('href', 'https://github.com/o/web/issues/12#issuecomment-9');
    expect(posted).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getAllByRole('link', { name: 'Status comment posted' })).toHaveLength(1);
    expect(screen.getByText('2 answers from members')).toBeInTheDocument();
    expect(screen.getByText(/Status comment not posted: GitHub refused .* Issues: write/)).toBeInTheDocument();
    expect(screen.getAllByText(/Status comment not posted/)).toHaveLength(1);
  });

  it('renders every status with its label', async () => {
    const all = ['new', 'refining', 'drafted', 'failed', 'withdrawn', 'ignored'] as const;
    setup(all.map((s, n) => intakeItem({ id: `i${n}`, status: s, number: n + 1 })));
    render(<IntakeView />);
    await screen.findByRole('link', { name: '#1 Add dark mode' });
    for (const label of ['New', 'Refining', 'Drafted', 'Failed', 'Withdrawn', 'Ignored']) {
      expect(within(screen.getByRole('list')).getAllByText(label).length).toBe(1);
    }
  });

  it('filters by status without another request, and resets', async () => {
    const list = setup([intakeItem(), intakeItem({ id: 'i2', number: 13, title: 'Other', status: 'failed' })]);
    render(<IntakeView />);
    await screen.findByRole('link', { name: '#12 Add dark mode' });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });
    expect(screen.queryByRole('link', { name: '#12 Add dark mode' })).toBeNull();
    expect(screen.getByRole('link', { name: '#13 Other' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'ignored' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByRole('link', { name: '#12 Add dark mode' })).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('offers Retry for failed and ignored, Ignore for new, drafted and failed, nothing for the rest', async () => {
    const all = ['new', 'refining', 'drafted', 'failed', 'withdrawn', 'ignored'] as const;
    setup(all.map((s, n) => intakeItem({ id: s, status: s, number: n + 1, title: s })));
    render(<IntakeView />);
    await screen.findByRole('link', { name: '#1 new' });
    const card = (s: string) => within(screen.getByRole('link', { name: new RegExp(`^#\\d+ ${s}$`) }).closest('li')!);
    const names = (s: string) => card(s).queryAllByRole('button').map((b) => b.textContent);
    expect(names('new')).toEqual(['Ignore', 'Archive']);
    expect(names('refining')).toEqual(['Archive']);
    expect(names('drafted')).toEqual(['Ignore', 'Archive']);
    expect(names('failed')).toEqual(['Retry', 'Ignore', 'Archive']);
    expect(names('withdrawn')).toEqual(['Archive']);
    expect(names('ignored')).toEqual(['Retry', 'Archive']);
  });

  it('retries and ignores an item, then reloads', async () => {
    const list = setup([intakeItem({ status: 'failed' })]);
    const retry = vi.spyOn(api, 'retryIntake').mockResolvedValue(intakeItem());
    const ignore = vi.spyOn(api, 'ignoreIntake').mockResolvedValue(intakeItem({ status: 'ignored' }));
    render(<IntakeView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith('i1'));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(ignore).toHaveBeenCalledWith('i1'));
  });

  it('explains a 403 on retry', async () => {
    setup([intakeItem({ status: 'failed' })]);
    vi.spyOn(api, 'retryIntake').mockRejectedValue(new ApiError('Forbidden', 403, 'Forbidden'));
    render(<IntakeView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only a signed-in person can retry intake items');
  });

  it('sweeps and reports the result, and explains a 403', async () => {
    setup();
    const sweep = vi.spyOn(api, 'sweepIntake').mockResolvedValueOnce({ repos: 3, skipped: 1, upserted: 2, withdrawn: 0 });
    render(<IntakeView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sweep now' }));
    expect(await screen.findByText(/Swept 3 repos \(1 skipped\): 2 items created or changed, 0 withdrawn/)).toBeInTheDocument();
    sweep.mockRejectedValueOnce(new ApiError('Forbidden', 403, 'Forbidden'));
    fireEvent.click(screen.getByRole('button', { name: 'Sweep now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only a signed-in person can sweep for intake items');
  });

  it('explains the label when there are no items', async () => {
    setup([]);
    render(<IntakeView />);
    expect(await screen.findByText('No intake items')).toBeInTheDocument();
    expect(screen.getByText(/Label a GitHub issue in a registered repo with gilde:refine/)).toBeInTheDocument();
  });

  it('shows a skeleton while loading, then an error with retry', async () => {
    setup();
    const list = vi.spyOn(api, 'listIntake').mockRejectedValue(new Error('boom'));
    render(<IntakeView />);
    expect(screen.getByLabelText('Loading intake')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.queryByLabelText('Loading intake')).toBeNull();
    list.mockResolvedValue([intakeItem()]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: '#12 Add dark mode' })).toBeInTheDocument();
  });

  it('explains that items are collected but not refined when the Verfijner is disabled', async () => {
    setup([intakeItem()], false);
    render(<IntakeView />);
    const note = await screen.findByText(/collected but not refined/, undefined, { timeout: 5000 });
    expect(note).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'How to enable it' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(await screen.findByRole('link', { name: '#12 Add dark mode' })).toBeInTheDocument();
  });

  it('does not show the disabled note when the Verfijner is on', async () => {
    setup();
    render(<IntakeView />);
    await screen.findByRole('link', { name: '#12 Add dark mode' });
    await waitFor(() => expect(api.copilotStatus).toHaveBeenCalled());
    expect(screen.queryByText(/collected but not refined/)).toBeNull();
  });

  it('archives an item only after confirming, then reloads', async () => {
    const list = setup();
    const archive = vi.spyOn(api, 'archiveIntake').mockResolvedValue(intakeItem());
    render(<IntakeView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    expect(archive).not.toHaveBeenCalled();
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Archive this intake item?')).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(archive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith('i1'));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('explains a refused archive in the dialog', async () => {
    setup();
    vi.spyOn(api, 'archiveIntake').mockRejectedValue(new ApiError('403', 403));
    render(<IntakeView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Archive' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('Only a signed-in person can archive this intake item');
  });

  it('shows archived items with a badge and Unarchive when the Archived filter is on', async () => {
    const list = setup();
    list.mockImplementation(async (_p, _s, archived) => (archived ? [intakeItem({ archivedAt: '2026-02-01T00:00:00.000Z', status: 'failed' })] : [intakeItem()]));
    const unarchive = vi.spyOn(api, 'unarchiveIntake').mockResolvedValue(intakeItem());
    render(<IntakeView />);
    await screen.findByRole('link', { name: '#12 Add dark mode' });
    expect(screen.queryByText('Archived', { selector: 'span' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Archived' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith('p', undefined, true));
    expect(await screen.findByText('Archived', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    await waitFor(() => expect(unarchive).toHaveBeenCalledWith('i1'));
  });
});
