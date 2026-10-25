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
import { DispatchStrip } from './dispatch-strip';
import { JobModal } from './job-modal';
import { Sidebar } from './sidebar';

const POLL_MS = 5000;

export function Dashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [selected, setSelected] = useState<Job | null>(null);
  const [creating, setCreating] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [featureFilter, setFeatureFilter] = useState('');
  const [creatorFilter, setCreatorFilter] = useState<'' | 'me'>('');

  const projects = usePolling(api.listProjects, 30_000);
  const requested = params.get('project');
  const projectId =
    projects.data?.find((p) => p.id === requested)?.id ?? projects.data?.[0]?.id ?? null;

  const fetchRepos = useCallback(() => (projectId ? api.listRepos(projectId) : Promise.resolve([])), [projectId]);
  const fetchJobs = useCallback(() => (projectId ? api.listJobs(projectId, creatorFilter || undefined) : Promise.resolve([])), [projectId, creatorFilter]);
  const fetchFeatures = useCallback(() => (projectId ? api.listFeatures(projectId) : Promise.resolve([])), [projectId]);
  const repos = usePolling(fetchRepos, POLL_MS);
  const features = usePolling(fetchFeatures, POLL_MS);
  const jobs = usePolling(fetchJobs, POLL_MS);
  const dispatch = usePolling(api.getDispatchStatus, POLL_MS);

  const project = projects.data?.find((p) => p.id === projectId);
  const refreshAll = async () => {
    await Promise.all([projects.refresh(), repos.refresh(), jobs.refresh()]);
  };

  const selectProject = (id: string) => {
    setFeatureFilter('');
    router.replace(`${pathname}?project=${encodeURIComponent(id)}`);
  };

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
              <select
                aria-label="Feature filter"
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={featureFilter}
                onChange={(e) => setFeatureFilter(e.target.value)}
              >
                <option value="">All features</option>
                <option value="none">No feature</option>
                {features.data?.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.title}
                  </option>
                ))}
              </select>
              <select
                aria-label="Created by filter"
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={creatorFilter}
                onChange={(e) => setCreatorFilter(e.target.value as '' | 'me')}
              >
                <option value="">Anyone</option>
                <option value="me">Me</option>
              </select>
              <Button onClick={() => setCreating(true)}>New job</Button>
            </div>
          </header>
        )}
        {warnings.length > 0 && (
          <div role="status" className="m-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <ul className="list-disc pl-4">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            <button type="button" className="mt-1 underline" onClick={() => setWarnings([])}>
              Dismiss
            </button>
          </div>
        )}
        {projectId && <DispatchStrip repos={(dispatch.data?.result?.repos ?? []).filter((d) => repos.data?.some((r) => r.id === d.repoId))} />}
        {projectId && (
          <Board
            jobs={jobs.data ?? []}
            repos={repos.data ?? []}
            features={features.data ?? []}
            featureFilter={featureFilter}
            onOpen={setSelected}
            onChanged={jobs.refresh}
            onEnqueued={setWarnings}
          />
        )}
      </main>
      <JobModal job={selected} projectJobs={jobs.data ?? []} onClose={() => setSelected(null)} onChanged={jobs.refresh} onEnqueued={setWarnings} />
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
