import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Project, type Repo } from '@/lib/api';
import { ProjectsView } from './projects-view';

const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => nav,
  usePathname: () => '/settings/projects',
  useSearchParams: () => new URLSearchParams('project=p1'),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const project = (over: Partial<Project> = {}) =>
  ({ id: 'p1', slug: 'shop', name: 'Shop', description: null, dailyRunLimit: 20, paused: false, ...over }) as Project;

beforeEach(() => {
  window.localStorage.clear();
  nav.replace.mockClear();
  nav.push.mockClear();
  vi.spyOn(api, 'listRepos').mockResolvedValue([{ id: 'r1' }, { id: 'r2' }] as Repo[]);
});
afterEach(() => vi.restoreAllMocks());

describe('ProjectsView', () => {
  it('lists projects with slug, repo count, limit and paused badge', async () => {
    vi.spyOn(api, 'listProjects').mockResolvedValue([project(), project({ id: 'p2', slug: 'blog', name: 'Blog', paused: true })]);
    render(<ProjectsView />);
    expect(await screen.findByRole('link', { name: 'Shop' })).toHaveAttribute('href', '/settings/projects/p1?project=p1');
    expect(screen.getByText('blog')).toBeInTheDocument();
    expect(screen.getByText('paused')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('2')).toHaveLength(2));
    expect(screen.getAllByText('20')).toHaveLength(2);
  });

  it('creates a project with a derived slug, selects it and opens its page', async () => {
    vi.spyOn(api, 'listProjects').mockResolvedValue([project()]);
    const create = vi.spyOn(api, 'createProject').mockResolvedValue(project({ id: 'p9', slug: 'my-new-app', name: 'My New App' }));
    render(<ProjectsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My New App' } });
    expect(screen.getByLabelText('Slug')).toHaveValue('my-new-app');
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/settings/projects/p9?project=p9'));
    expect(create).toHaveBeenCalledWith({ name: 'My New App', slug: 'my-new-app', description: 'Hello' });
    expect(window.localStorage.getItem('gilde_project')).toBe('p9');
    expect(nav.replace).toHaveBeenCalledWith(expect.stringContaining('project=p9'));
  });

  it('keeps an edited slug when the name changes', async () => {
    vi.spyOn(api, 'listProjects').mockResolvedValue([project()]);
    render(<ProjectsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Other' } });
    expect(screen.getByLabelText('Slug')).toHaveValue('custom');
  });
});
