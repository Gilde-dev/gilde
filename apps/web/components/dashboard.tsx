'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { api, type Job } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { Button } from './ui/button';
import { NewJobDialog } from './new-job-dialog';
import { PauseToggle } from './pause-toggle';
import { Badge } from './ui/badge';
import { Board } from './board';
import { JobModal } from './job-modal';
import { Sidebar } from './sidebar';

const POLL_MS = 5000;

export function Dashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [selected, setSelected] = useState<Job | null>(null);
  const [creating, setCreating] = useState(false);

  const projects = usePolling(api.listProjects, 30_000);
  const requested = params.get('project');
  const projectId =
    projects.data?.find((p) => p.id === requested)?.id ?? projects.data?.[0]?.id ?? null;

  const fetchRepos = useCallback(() => (projectId ? api.listRepos(projectId) : Promise.resolve([])), [projectId]);
  const fetchJobs = useCallback(() => (projectId ? api.listJobs(projectId) : Promise.resolve([])), [projectId]);
  const repos = usePolling(fetchRepos, POLL_MS);
  const jobs = usePolling(fetchJobs, POLL_MS);

  const project = projects.data?.find((p) => p.id === projectId);
  const refreshAll = async () => {
    await Promise.all([projects.refresh(), repos.refresh(), jobs.refresh()]);
  };

  const selectProject = (id: string) => router.replace(`${pathname}?project=${encodeURIComponent(id)}`);

  return (
    <div className="flex min-h-screen">
      <Sidebar
        projects={projects.data ?? []}
        projectId={projectId}
        repos={repos.data}
        reposError={repos.error}
        onSelectProject={selectProject}
        onChanged={refreshAll}
      />
      <main className="min-w-0 flex-1">
        {projects.error && <p className="p-4 text-sm text-red-800">{projects.error.message}</p>}
        {jobs.error && <p className="p-4 text-sm text-red-800">{jobs.error.message}</p>}
        {projects.data?.length === 0 && <p className="p-4 text-sm text-muted-foreground">No projects yet.</p>}
        {project && (
          <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
            <h2 className="text-lg font-semibold">{project.name}</h2>
            {project.paused && <Badge variant="warning">Paused</Badge>}
            <div className="ml-auto flex items-center gap-2">
              <PauseToggle
                paused={project.paused}
                label={`project ${project.name}`}
                toggle={(paused) => api.setProjectPaused(project.id, paused)}
                onChanged={refreshAll}
              />
              <Button onClick={() => setCreating(true)}>New job</Button>
            </div>
          </header>
        )}
        {projectId && (
          <Board jobs={jobs.data ?? []} repos={repos.data ?? []} onOpen={setSelected} onChanged={jobs.refresh} />
        )}
      </main>
      <JobModal job={selected} projectJobs={jobs.data ?? []} onClose={() => setSelected(null)} onChanged={jobs.refresh} />
      <NewJobDialog
        open={creating}
        repos={repos.data ?? []}
        jobs={jobs.data ?? []}
        onClose={() => setCreating(false)}
        onCreated={jobs.refresh}
      />
    </div>
  );
}
