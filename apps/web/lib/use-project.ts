'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, type Project } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';

export const PROJECT_STORAGE_KEY = 'gilde_project';
const POLL_MS = 30_000;

function readStored(): string | null {
  try {
    return window.localStorage.getItem(PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(id: string) {
  try {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, id);
  } catch {
    // storage unavailable: the URL still carries the choice
  }
}

/** Adds the selected project to an in-app link so it carries over between pages. */
export function withProject(href: string, projectId: string | null): string {
  if (!projectId) return href;
  return `${href}${href.includes('?') ? '&' : '?'}project=${encodeURIComponent(projectId)}`;
}

export interface ProjectSelection {
  projects: Project[] | undefined;
  project: Project | undefined;
  projectId: string | null;
  setProjectId: (id: string) => void;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * The selected project, shared by all pages. The `?project=` search parameter is the source of truth;
 * without it the last choice (localStorage), then the first project.
 */
export function useProject(): ProjectSelection {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const projects = usePolling(api.listProjects, POLL_MS);
  const [stored, setStored] = useState<string | null>(null);
  useEffect(() => setStored(readStored()), []);

  const requested = params.get('project');
  const list = projects.data;
  const project =
    list?.find((p) => p.id === requested) ?? list?.find((p) => p.id === stored) ?? list?.[0];
  const projectId = project?.id ?? null;

  const setProjectId = useCallback(
    (id: string) => {
      writeStored(id);
      setStored(id);
      const next = new URLSearchParams(params.toString());
      next.set('project', id);
      next.delete('job'); // a job belongs to one project
      // A feature page belongs to one project too: go back to the list of the new one.
      const path = pathname.startsWith('/features/') ? '/features' : pathname;
      router.replace(`${path}?${next.toString()}`);
    },
    [params, pathname, router],
  );

  return {
    projects: list,
    project,
    projectId,
    setProjectId,
    loading: projects.loading,
    error: projects.error,
    refresh: projects.refresh,
  };
}
