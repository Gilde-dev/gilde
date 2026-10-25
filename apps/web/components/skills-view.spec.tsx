import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Project, type RepoSkills, type SkillCatalog } from '@/lib/api';
import { SkillsView } from './skills-view';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const project = (over: Partial<Project> = {}) => ({ id: 'p1', name: 'Proj', skillsLibrary: 'folder', skillsLibraryRepoId: null, ...over }) as Project;

const catalog: SkillCatalog = {
  library: { kind: 'folder', repoFullName: null },
  skills: [{ name: 'alpha', description: 'Alpha skill', scope: 'global', stacks: [], files: ['SKILL.md'], repos: [{ id: 'r1', fullName: 'o/r' }] }],
};

const repoSkills: RepoSkills = {
  repoId: 'r1',
  skills: [
    { name: 'alpha', description: 'Alpha skill', source: 'managed', managedBy: 'lib@1', status: 'outdated' },
    { name: 'mine', description: null, source: 'repo', managedBy: null, status: 'repo' },
  ],
  counts: { ok: 0, outdated: 1, missing: 0, orphaned: 0, conflict: 0, repo: 1 },
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'listProjects').mockResolvedValue([project()]);
  vi.spyOn(api, 'listRepos').mockResolvedValue([{ id: 'r1', fullName: 'o/r' } as never]);
  vi.spyOn(api, 'getSkillCatalog').mockResolvedValue(catalog);
  vi.spyOn(api, 'getRepoSkills').mockResolvedValue(repoSkills);
});

describe('SkillsView', () => {
  it('shows the catalog, per repo skills with status badges and the sync note', async () => {
    render(<SkillsView />);
    const lib = await screen.findByLabelText('Library skill alpha');
    expect(within(lib).getByText('Alpha skill')).toBeInTheDocument();
    expect(within(lib).getByText(/Repos: o\/r/)).toBeInTheDocument();
    const repo = await screen.findByLabelText('Repo o/r');
    await waitFor(() => expect(within(repo).getByText('outdated')).toBeInTheDocument());
    expect(within(repo).getByText('repo')).toBeInTheDocument();
    expect(within(repo).getByText('1 outdated · 1 repo')).toBeInTheDocument();
    expect(screen.getByText(/repo sync workflow fixes outdated, missing and orphaned/)).toBeInTheDocument();
  });

  it('shows the API error when the library is unavailable', async () => {
    vi.spyOn(api, 'getSkillCatalog').mockRejectedValue(new ApiError('GET failed: 503 SKILLS_LIBRARY_PATH is not set on the server', 503));
    render(<SkillsView />);
    expect(await screen.findByText(/SKILLS_LIBRARY_PATH is not set/)).toBeInTheDocument();
  });

  it('says so when no library is configured and does not fetch the catalog', async () => {
    vi.spyOn(api, 'listProjects').mockResolvedValue([project({ skillsLibrary: 'none' })]);
    render(<SkillsView />);
    expect(await screen.findByText(/No skills library is configured/)).toBeInTheDocument();
    expect(api.getSkillCatalog).not.toHaveBeenCalled();
  });

  it('saves a repo library with the chosen repo', async () => {
    const update = vi.spyOn(api, 'updateProject').mockResolvedValue(project());
    render(<SkillsView />);
    await screen.findByLabelText('Library skill alpha');
    fireEvent.change(screen.getByLabelText('Skills library'), { target: { value: 'repo' } });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Library repo'), { target: { value: 'r1' } });
    fireEvent.click(save);
    await waitFor(() => expect(update).toHaveBeenCalledWith('p1', { skillsLibrary: 'repo', skillsLibraryRepoId: 'r1' }));
  });
});
