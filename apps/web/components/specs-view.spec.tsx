import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Project, type Repo } from '@/lib/api';
import { spec } from './spec.fixture';
import { SpecsView } from './specs-view';

const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/specs',
  useSearchParams: () => new URLSearchParams(nav.search),
}));

afterEach(() => {
  vi.restoreAllMocks();
  nav.search = '';
});

const projects = [{ id: 'p', name: 'P' }, { id: 'q', name: 'Q' }] as Project[];

function setup() {
  vi.spyOn(api, 'listProjects').mockResolvedValue(projects);
  vi.spyOn(api, 'listRepos').mockResolvedValue([{ id: 'r1', fullName: 'o/web' } as Repo]);
}

describe('SpecsView', () => {
  it('lists specs with repo, status and versions, linking with the project', async () => {
    setup();
    vi.spyOn(api, 'listSpecs').mockResolvedValue([spec(), spec({ id: 's2', title: 'Search', status: 'approved', approvedVersion: 3, currentVersion: 3 })]);
    render(<SpecsView />);
    expect(await screen.findByRole('link', { name: 'Dark mode' })).toHaveAttribute('href', '/specs/s1?project=p');
    expect(screen.getByRole('link', { name: 'Search' })).toHaveAttribute('href', '/specs/s2?project=p');
    expect(await screen.findAllByText('o/web')).toHaveLength(2);
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Never approved')).toBeInTheDocument();
    expect(screen.getByText('Approved v3')).toBeInTheDocument();
  });

  it('shows loading, then an empty state without fabricated rows', async () => {
    setup();
    vi.spyOn(api, 'listSpecs').mockResolvedValue([]);
    render(<SpecsView />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByText('No specs')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('shows an error', async () => {
    setup();
    vi.spyOn(api, 'listSpecs').mockRejectedValue(new Error('boom'));
    render(<SpecsView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.queryByText('No specs')).not.toBeInTheDocument();
  });

  it('loads the specs of the project in the URL and never mixes projects', async () => {
    setup();
    nav.search = 'project=q';
    const list = vi.spyOn(api, 'listSpecs').mockResolvedValue([spec({ id: 's9', title: 'Q spec', projectId: 'q' })]);
    render(<SpecsView />);
    expect(await screen.findByRole('link', { name: 'Q spec' })).toHaveAttribute('href', '/specs/s9?project=q');
    expect(list).toHaveBeenCalledWith('q', false);
    expect(list).not.toHaveBeenCalledWith('p', false);
  });

  it('refetches and drops the old list when the project changes', async () => {
    setup();
    vi.spyOn(api, 'listSpecs').mockImplementation(async (id) => [spec({ id: `s-${id}`, title: `Spec of ${id}` })]);
    nav.search = 'project=p';
    const { rerender } = render(<SpecsView />);
    expect(await screen.findByText('Spec of p')).toBeInTheDocument();
    nav.search = 'project=q';
    rerender(<SpecsView />);
    expect(await screen.findByText('Spec of q')).toBeInTheDocument();
    expect(screen.queryByText('Spec of p')).not.toBeInTheDocument();
  });

  it('links the issue a spec came from, opening in a new tab', async () => {
    setup();
    vi.spyOn(api, 'listSpecs').mockResolvedValue([spec({ source: { kind: 'github_issue', url: 'https://github.com/o/web/issues/7', number: 7 } }), spec({ id: 's2', title: 'By hand' })]);
    render(<SpecsView />);
    const link = await screen.findByRole('link', { name: 'From issue #7' });
    expect(link).toHaveAttribute('href', 'https://github.com/o/web/issues/7');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getAllByText(/From issue/)).toHaveLength(1);
  });

  it('shows archived specs with a badge when the Archived filter is on', async () => {
    setup();
    const list = vi.spyOn(api, 'listSpecs').mockImplementation(async (_p, archived) => (archived ? [spec({ title: 'Old spec', archivedAt: '2026-02-01T00:00:00.000Z' })] : [spec()]));
    render(<SpecsView />);
    await screen.findByRole('link', { name: 'Dark mode' });
    expect(screen.queryByText('Archived', { selector: 'span' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Archived' }));
    expect(await screen.findByRole('link', { name: 'Old spec' })).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith('p', true);
    expect(screen.getByText('Archived', { selector: 'span' })).toBeInTheDocument();
  });
});
