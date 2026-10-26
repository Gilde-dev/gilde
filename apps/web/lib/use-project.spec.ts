import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Project } from './api';
import { PROJECT_STORAGE_KEY, useProject, withProject } from './use-project';

const nav = vi.hoisted(() => ({ search: '', path: '/', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const projects = [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }, { id: 'p3', name: 'Three' }] as Project[];

beforeEach(() => {
  nav.search = '';
  nav.path = '/';
  nav.replace.mockClear();
  window.localStorage.clear();
  vi.spyOn(api, 'listProjects').mockResolvedValue(projects);
});
afterEach(() => vi.restoreAllMocks());

describe('useProject', () => {
  it('lets the URL win over localStorage', async () => {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, 'p3');
    nav.search = 'project=p2';
    const { result } = renderHook(() => useProject());
    await waitFor(() => expect(result.current.projectId).toBe('p2'));
    expect(result.current.project?.name).toBe('Two');
  });

  it('falls back to the last choice, then to the first project', async () => {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, 'p3');
    const stored = renderHook(() => useProject());
    await waitFor(() => expect(stored.result.current.projectId).toBe('p3'));

    window.localStorage.setItem(PROJECT_STORAGE_KEY, 'gone');
    nav.search = 'project=unknown';
    const first = renderHook(() => useProject());
    await waitFor(() => expect(first.result.current.projectId).toBe('p1'));
  });

  it('setProjectId updates the URL (keeping other params) and localStorage', async () => {
    nav.search = 'project=p1&status=open&job=j1';
    const { result } = renderHook(() => useProject());
    await waitFor(() => expect(result.current.projectId).toBe('p1'));
    act(() => result.current.setProjectId('p2'));
    expect(nav.replace).toHaveBeenCalledWith('/?project=p2&status=open');
    expect(window.localStorage.getItem(PROJECT_STORAGE_KEY)).toBe('p2');
  });

  it('leaves a feature page for the features list of the new project', async () => {
    nav.path = '/features/f1';
    nav.search = 'project=p1';
    const { result } = renderHook(() => useProject());
    await waitFor(() => expect(result.current.projectId).toBe('p1'));
    act(() => result.current.setProjectId('p2'));
    expect(nav.replace).toHaveBeenCalledWith('/features?project=p2');
  });

  it('has no project when there are none, and survives unavailable storage', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([]);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useProject());
    await waitFor(() => expect(result.current.projects).toEqual([]));
    expect(result.current.projectId).toBeNull();
  });
});

describe('withProject', () => {
  it('appends the project to a link', () => {
    expect(withProject('/features', 'p 1')).toBe('/features?project=p%201');
    expect(withProject('/x?a=1', 'p1')).toBe('/x?a=1&project=p1');
    expect(withProject('/x', null)).toBe('/x');
  });
});
