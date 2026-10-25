import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Repo } from '@/lib/api';
import { RepoManifest } from './repo-manifest';

const repo = {
  id: 'r1',
  fullName: 'o/r',
  stacks: ['nestjs', 'nextjs'],
  testCommands: ['pnpm test'],
  manifestSyncedAt: '2026-01-01T00:00:00.000Z',
  manifestError: null,
} as unknown as Repo;

afterEach(() => vi.restoreAllMocks());

describe('RepoManifest', () => {
  it('shows stacks, test commands and sync time', () => {
    render(<RepoManifest repo={repo} onChanged={() => {}} />);
    expect(screen.getByText('Stacks: nestjs, nextjs')).toBeInTheDocument();
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
    expect(screen.getByText(/Manifest synced/)).toBeInTheDocument();
  });

  it('shows the manifest error', () => {
    render(<RepoManifest repo={{ ...repo, manifestError: '.gilde.json not found on main', manifestSyncedAt: null }} onChanged={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent('.gilde.json not found on main');
    expect(screen.getByText('Manifest not synced yet')).toBeInTheDocument();
  });

  it('refreshes and reloads', async () => {
    const refresh = vi.spyOn(api, 'refreshRepoManifest').mockResolvedValue(repo);
    const onChanged = vi.fn();
    render(<RepoManifest repo={repo} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh manifest o/r' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalledWith('r1');
  });
});
