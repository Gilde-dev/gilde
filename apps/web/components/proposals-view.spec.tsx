import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Revision } from '@/lib/api';
import { ProposalsView, revisionDiff } from './proposals-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));


vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const revision = (over: Partial<Revision> = {}): Revision => ({
  id: 'rev1',
  jobId: 'j2',
  revision: null,
  title: null,
  task: 'New task text',
  acceptanceCriteria: ['New criterion'],
  dependsOn: null,
  reason: 'I renamed the endpoint',
  sourceRunId: 'run1',
  status: 'proposed',
  decidedAt: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  job: { id: 'j2', title: 'Next job', task: 'Old task text', acceptanceCriteria: ['Old criterion'], dependsOn: ['a'], status: 'queued' },
  pr: { number: 7, url: 'https://github.com/o/r/pull/7' },
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'listProjects').mockResolvedValue([{ id: 'p1', name: 'Proj' } as never]);
});

describe('revisionDiff', () => {
  it('lists only the changed fields', () => {
    expect(revisionDiff(revision()).map((d) => d.field)).toEqual(['Task', 'Acceptance criteria']);
    expect(revisionDiff(revision({ dependsOn: [] }))[2]).toEqual({ field: 'Dependencies', before: '- a', after: '(none)' });
  });
});

describe('ProposalsView', () => {
  it('shows the diff, the reason and the PR link', async () => {
    vi.spyOn(api, 'listRevisions').mockResolvedValue([revision()]);
    render(<ProposalsView />);
    const card = await screen.findByRole('listitem', { name: 'Next job' });
    expect(within(card).getByLabelText('Task before')).toHaveTextContent('Old task text');
    expect(within(card).getByLabelText('Task after')).toHaveTextContent('New task text');
    expect(within(card).getByText(/I renamed the endpoint/)).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /PR #7/ })).toHaveAttribute('href', 'https://github.com/o/r/pull/7');
  });

  it('accepts and rejects, then reloads', async () => {
    const list = vi.spyOn(api, 'listRevisions').mockResolvedValue([revision()]);
    const accept = vi.spyOn(api, 'acceptRevision').mockResolvedValue(revision({ status: 'accepted' }));
    const reject = vi.spyOn(api, 'rejectRevision').mockResolvedValue(revision({ status: 'rejected' }));
    render(<ProposalsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith('rev1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(reject).toHaveBeenCalledWith('rev1'));
    expect(list.mock.calls.length).toBeGreaterThan(2);
  });

  it('shows the API error when accepting fails', async () => {
    vi.spyOn(api, 'listRevisions').mockResolvedValue([revision()]);
    vi.spyOn(api, 'acceptRevision').mockRejectedValue(new Error('Dependency cycle'));
    render(<ProposalsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Dependency cycle');
  });
});
