'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { api, type Job } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { Board } from './board';
import { JobModal } from './job-modal';
import { Sidebar } from './sidebar';

const POLL_MS = 5000;

export function Dashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [selected, setSelected] = useState<Job | null>(null);

  const projects = usePolling(api.listProjects, 30_000);
  const requested = params.get('project');
  const projectId =
    projects.data?.find((p) => p.id === requested)?.id ?? projects.data?.[0]?.id ?? null;

  const fetchRepos = useCallback(() => (projectId ? api.listRepos(projectId) : Promise.resolve([])), [projectId]);
  const fetchJobs = useCallback(() => (projectId ? api.listJobs(projectId) : Promise.resolve([])), [projectId]);
  const repos = usePolling(fetchRepos, POLL_MS);
  const jobs = usePolling(fetchJobs, POLL_MS);

  const selectProject = (id: string) => router.replace(`${pathname}?project=${encodeURIComponent(id)}`);

  return (
    <div className="flex min-h-screen">
      <Sidebar
        projects={projects.data ?? []}
        projectId={projectId}
        repos={repos.data}
        reposError={repos.error}
        onSelectProject={selectProject}
      />
      <main className="min-w-0 flex-1">
        {projects.error && <p className="p-4 text-sm text-red-800">{projects.error.message}</p>}
        {jobs.error && <p className="p-4 text-sm text-red-800">{jobs.error.message}</p>}
        {projects.data?.length === 0 && <p className="p-4 text-sm text-muted-foreground">No projects yet.</p>}
        {projectId && <Board jobs={jobs.data ?? []} repos={repos.data ?? []} onOpen={setSelected} />}
      </main>
      <JobModal job={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
