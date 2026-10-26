import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Project, type Repo, type Revision } from '@/lib/api';
import { AppShell } from './app-shell';

const nav = vi.hoisted(() => ({ path: '/features', search: 'project=p2', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const projects = [{ id: 'p1', name: 'One', paused: false }, { id: 'p2', name: 'Two', paused: false }] as Project[];
const repos = [
  { id: 'r1', fullName: 'o/api', paused: false },
  { id: 'r2', fullName: 'o/web', paused: true },
] as Repo[];

beforeEach(() => {
  nav.path = '/features';
  nav.search = 'project=p2';
  nav.replace.mockClear();
  window.localStorage.clear();
  vi.spyOn(api, 'listProjects').mockResolvedValue(projects);
  vi.spyOn(api, 'listRepos').mockResolvedValue(repos);
  vi.spyOn(api, 'listRevisions').mockResolvedValue([{ id: 'v1' }, { id: 'v2' }] as Revision[]);
  vi.spyOn(api, 'me').mockResolvedValue({ id: 'u', name: 'Pascal', email: 'p@x.nl' } as never);
});
afterEach(() => vi.restoreAllMocks());

const mainNav = () => screen.getAllByRole('navigation', { name: 'Main' })[0];

describe('AppShell', () => {
  it('renders navigation with the active link, project-aware hrefs and the pending proposals count', async () => {
    render(
      <AppShell>
        <p>Page content</p>
      </AppShell>,
    );
    expect(screen.getByText('Page content')).toBeInTheDocument();
    const nav = within(mainNav());
    expect(nav.getByRole('link', { name: 'Features' })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('link', { name: 'Board' })).not.toHaveAttribute('aria-current');
    await waitFor(() => expect(nav.getByRole('link', { name: 'Board' })).toHaveAttribute('href', '/?project=p2'));
    expect(await nav.findByLabelText('2 pending')).toBeInTheDocument();
    expect(api.listRevisions).toHaveBeenCalledWith('proposed', 'p2');
    const settings = within(screen.getAllByRole('navigation', { name: 'Settings' })[0]);
    expect(settings.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/settings/projects?project=p2');
    expect(settings.getByRole('link', { name: 'API keys' })).toBeInTheDocument();
    expect(await screen.findByText('Pascal')).toBeInTheDocument();
  });

  it('switches project through the URL and lists repos with a paused badge', async () => {
    render(<AppShell>x</AppShell>);
    const select = screen.getAllByRole('combobox', { name: 'Project' })[0];
    await waitFor(() => expect(select).toHaveValue('p2'));
    fireEvent.change(select, { target: { value: 'p1' } });
    expect(nav.replace).toHaveBeenCalledWith('/features?project=p1');
    const web = await screen.findByRole('link', { name: 'o/web' });
    expect(web).toHaveAttribute('href', 'https://github.com/o/web');
    expect(screen.getByText('paused')).toBeInTheDocument();
  });

  it('opens and closes the drawer on small screens', async () => {
    render(<AppShell>x</AppShell>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Menu' });
    expect(within(drawer).getByRole('link', { name: 'Metrics' })).toBeInTheDocument();
    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close menu' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes the drawer when a link is followed', async () => {
    render(<AppShell>x</AppShell>);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByRole('dialog');
    fireEvent.click(within(drawer).getByRole('link', { name: 'Lessons' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
