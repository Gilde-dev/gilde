import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Repo } from '@/lib/api';
import { GithubAppStatus, ReposSection } from './repos-section';

const repo = {
  id: 'r1', projectId: 'p1', fullName: 'o/r', defaultBranch: 'main', maxConcurrentJobs: 1, stacks: [], testCommands: [],
  manifestSyncedAt: null, manifestError: null, paused: false, githubAppInstalled: null, githubAppWarning: null,
} as unknown as Repo;

afterEach(() => vi.restoreAllMocks());

describe('GithubAppStatus', () => {
  it('shows nothing until an installation event was seen', () => {
    const { container } = render(<GithubAppStatus repo={repo} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows installed and not installed', () => {
    const { rerender } = render(<GithubAppStatus repo={{ ...repo, githubAppInstalled: true }} />);
    expect(screen.getByText('GitHub App installed')).toBeInTheDocument();
    rerender(<GithubAppStatus repo={{ ...repo, githubAppInstalled: false }} />);
    expect(screen.getByText('GitHub App not installed')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('warns when the registered repo lost its installation', () => {
    render(<GithubAppStatus repo={{ ...repo, githubAppInstalled: false, githubAppWarning: 'The Gilde GitHub App is no longer installed on o/r.' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('no longer installed on o/r');
  });
});

describe('ReposSection', () => {
  it('shows the app status in the repo row', async () => {
    vi.spyOn(api, 'listRepos').mockResolvedValue([{ ...repo, githubAppInstalled: true }]);
    vi.spyOn(api, 'getRepoWorkspace').mockResolvedValue({ cloned: false, headSha: null, fetchedAt: null, error: null });
    render(<ReposSection projectId="p1" />);
    await waitFor(() => expect(screen.getByText('GitHub App installed')).toBeInTheDocument());
  });
});
