import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Job, type Project, type Repo, type Revision } from '@/lib/api';
import { AppShell, SIDEBAR_STORAGE_KEY } from './app-shell';

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
  vi.spyOn(api, 'listJobs').mockResolvedValue([]);
  vi.spyOn(api, 'listIntake').mockResolvedValue([]);
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
    expect(nav.getByRole('link', { name: 'Chat' })).toHaveAttribute('href', '/chat?project=p2');
    expect(nav.getByRole('link', { name: 'Agents' })).toHaveAttribute('href', '/agents?project=p2');
    expect(await nav.findByLabelText('2 pending')).toBeInTheDocument();
    expect(api.listRevisions).toHaveBeenCalledWith('proposed', 'p2');
    const settings = within(screen.getAllByRole('navigation', { name: 'Settings' })[0]);
    expect(settings.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/settings/projects?project=p2');
    expect(settings.getByRole('link', { name: 'API keys' })).toBeInTheDocument();
    expect(settings.getByRole('link', { name: 'Executors' })).toHaveAttribute('href', '/settings/executors?project=p2');
    expect(await screen.findByText('Pascal')).toBeInTheDocument();
  });

  it('switches project through the URL and lists repos with a paused badge', async () => {
    render(<AppShell>x</AppShell>);
    const select = screen.getAllByRole('combobox', { name: 'Project' })[0];
    await waitFor(() => expect(select).toHaveValue('p2'));
    fireEvent.change(select, { target: { value: 'p1' } });
    expect(nav.replace).toHaveBeenCalledWith('/features?project=p1');
    const web = await screen.findByRole('link', { name: 'o/web' });
    expect(web).toHaveAttribute('href', expect.stringMatching(/^\/settings\/projects\/p\d\?project=p\d#repo-/));
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

  it('has one main landmark with a breadcrumb inside the bordered panel', async () => {
    render(<AppShell>x</AppShell>);
    const main = screen.getByRole('main');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(main).toHaveClass('rounded-xl', 'border');
    const crumbs = within(main).getByRole('navigation', { name: 'Breadcrumb' });
    expect(await within(crumbs).findByRole('link', { name: 'Two' })).toHaveAttribute('href', '/?project=p2');
    expect(within(crumbs).getByText('Features')).toHaveAttribute('aria-current', 'page');
  });

  it('badges Board with the loaded queued/running/PR/review jobs of the project, and not other statuses', async () => {
    const mk = (status: string) => ({ id: status + Math.random(), projectId: 'p2', status }) as unknown as Job;
    vi.mocked(api.listJobs).mockResolvedValue(['queued', 'dispatched', 'pr_open', 'awaiting_review', 'triage', 'parked', 'merged'].map(mk));
    render(<AppShell>x</AppShell>);
    const badge = await within(mainNav()).findByLabelText('4 active');
    expect(badge).toHaveTextContent('4');
    expect(badge).toHaveAttribute('title', expect.stringContaining('up to 200'));
    expect(api.listJobs).toHaveBeenCalledWith('p2');
  });

  it('shows no Board badge while loading, on error or with nothing active', async () => {
    vi.mocked(api.listJobs).mockRejectedValue(new Error('x'));
    render(<AppShell>x</AppShell>);
    await screen.findByLabelText('2 pending');
    expect(screen.queryByLabelText(/active$/)).toBeNull();
  });

  it('uses the 240px sidebar by default and a 64px rail when collapsed, persisting the choice', async () => {
    const { unmount } = render(<AppShell>x</AppShell>);
    const aside = () => document.querySelector('aside')!;
    expect(aside()).toHaveClass('w-60');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(aside()).toHaveClass('w-16');
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('1');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-pressed', 'true');
    unmount();

    render(<AppShell>x</AppShell>); // a reload restores the rail
    await waitFor(() => expect(aside()).toHaveClass('w-16'));
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(aside()).toHaveClass('w-60');
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('0');
  });

  it('keeps labels, tooltips, current page, counts and the project and user controls in the rail', async () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, '1');
    render(<AppShell>x</AppShell>);
    await waitFor(() => expect(document.querySelector('aside')).toHaveClass('w-16'));
    const nav = within(mainNav());
    const features = nav.getByRole('link', { name: 'Features' });
    expect(features).toHaveAttribute('aria-current', 'page');
    expect(features).toHaveAttribute('title', 'Features');
    expect(await nav.findByLabelText('2 pending')).toBeInTheDocument();
    expect(screen.getAllByRole('combobox', { name: 'Project' })[0]).toHaveValue('p2');
    expect(screen.getByRole('combobox', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Repos' })).toBeNull();
  });

  it('keeps the mobile drawer expanded and independent of the desktop rail', async () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, '1');
    render(<AppShell>x</AppShell>);
    await waitFor(() => expect(document.querySelector('aside')).toHaveClass('w-16'));
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Menu' });
    const metrics = within(drawer).getByRole('link', { name: 'Metrics' });
    expect(within(metrics).getByText('Metrics')).not.toHaveClass('sr-only');
    expect(within(drawer).getByText('Gilde')).toBeInTheDocument();
    expect(await within(drawer).findByText('p@x.nl')).toBeInTheDocument();
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('1');
    fireEvent.click(within(drawer).getByRole('link', { name: 'Lessons' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.querySelector('aside')).toHaveClass('w-16');
  });

  it('returns focus to the menu button when the drawer closes', async () => {
    render(<AppShell>x</AppShell>);
    const trigger = screen.getByRole('button', { name: 'Open menu' });
    trigger.focus();
    fireEvent.click(trigger);
    const drawer = await screen.findByRole('dialog');
    expect(drawer.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('shows the user avatar, name and email at the bottom of the sidebar', async () => {
    render(<AppShell>x</AppShell>);
    expect(await screen.findByText('p@x.nl')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Pascal' })).toHaveTextContent('PA');
  });
});

describe('AppShell intake nav', () => {
  it('links Intake with the project and badges failed items only', async () => {
    vi.spyOn(api, 'listIntake').mockResolvedValue([{ id: 'i1' }, { id: 'i2' }] as never);
    render(<AppShell><p>x</p></AppShell>);
    const link = await within(mainNav()).findByRole('link', { name: /Intake/ });
    expect(link).toHaveAttribute('href', '/intake?project=p2');
    expect(await within(link).findByLabelText('2 failed')).toBeInTheDocument();
  });

  it('shows no badge without failed items', async () => {
    render(<AppShell><p>x</p></AppShell>);
    const link = await within(mainNav()).findByRole('link', { name: /Intake/ });
    await waitFor(() => expect(api.listIntake).toHaveBeenCalledWith('p2', 'failed'));
    expect(within(link).queryByLabelText(/failed/)).toBeNull();
  });
});
