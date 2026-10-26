'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Job } from '@/lib/api';
import { useProject } from '@/lib/use-project';
import { usePolling } from '@/lib/use-polling';
import { Button } from './ui/button';
import { NewJobDialog } from './new-job-dialog';
import { PauseToggle } from './pause-toggle';
import { Badge } from './ui/badge';
import { Board } from './board';
import { DispatchStrip } from './dispatch-strip';
import { JobModal } from './job-modal';
import { CopilotPageContext } from './copilot-provider';
import { NoProjects } from './no-projects';

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

  const projects = useProject();
  const { project, projectId } = projects;
  const requested = params.get('project');

  const fetchRepos = useCallback(() => (projectId ? api.listRepos(projectId) : Promise.resolve([])), [projectId]);
  const fetchJobs = useCallback(() => (projectId ? api.listJobs(projectId, creatorFilter || undefined) : Promise.resolve([])), [projectId, creatorFilter]);
  const fetchFeatures = useCallback(() => (projectId ? api.listFeatures(projectId) : Promise.resolve([])), [projectId]);
  const repos = usePolling(fetchRepos, POLL_MS);
  const features = usePolling(fetchFeatures, POLL_MS);
  const jobs = usePolling(fetchJobs, POLL_MS);
  const dispatch = usePolling(api.getDispatchStatus, POLL_MS);

  // Deep link /?project=<id>&job=<id>: fetch the job by id so it opens regardless of board filters.
  const jobParam = params.get('job');
  const currentProject = useRef<string | null>(null);
  currentProject.current = projectId ?? requested;
  useEffect(() => {
    if (!jobParam) return;
    let cancelled = false;
    const withProject = (pid: string | null, jobId?: string) => {
      const query = new URLSearchParams();
      if (pid) query.set('project', pid);
      if (jobId) query.set('job', jobId);
      const qs = query.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    };
    api
      .getJob(jobParam)
      .then((job) => {
        if (cancelled) return;
        setSelected(job);
        if (job.projectId !== currentProject.current) withProject(job.projectId, jobParam);
      })
      .catch(() => {
        if (cancelled) return;
        setWarnings(['That job could not be opened: it does not exist or you cannot access it.']);
        withProject(currentProject.current);
      });
    return () => {
      cancelled = true;
    };
    // Only a changed job parameter should fetch; project switches and polling must not reopen the modal.
  }, [jobParam]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeJob = () => {
    setSelected(null);
    if (jobParam) {
      const pid = selected?.projectId ?? projectId;
      router.replace(pid ? `${pathname}?project=${encodeURIComponent(pid)}` : pathname);
    }
  };
  const refreshAll = async () => {
    await Promise.all([projects.refresh(), repos.refresh(), jobs.refresh()]);
  };

  // Another project: the open job and the feature filter belong to the previous one.
  useEffect(() => {
    setSelected((s) => (s && s.projectId !== projectId && !jobParam ? null : s));
    setFeatureFilter('');
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
        {projects.error && <p className="p-4 text-sm text-danger">{projects.error.message}</p>}
        {jobs.error && <p className="p-4 text-sm text-danger">{jobs.error.message}</p>}
        {repos.error && <p className="p-4 text-sm text-danger">{repos.error.message}</p>}
        {projects.projects?.length === 0 && <NoProjects />}
        {project && (
          <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
            <h2 className="font-serif text-lg font-semibold">{project.name}</h2>
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
                className="h-9 rounded-md border border-input bg-card px-2 text-sm"
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
                className="h-9 rounded-md border border-input bg-card px-2 text-sm"
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
          <div role="status" className="m-4 rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-warning">
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
      {projectId && <CopilotPageContext description="The project selected in the Gilde UI" value={{ projectId }} />}
      <JobModal job={selected} projectJobs={jobs.data ?? []} onClose={closeJob} onChanged={jobs.refresh} onEnqueued={setWarnings} />
      <NewJobDialog
        open={creating}
        repos={repos.data ?? []}
        jobs={jobs.data ?? []}
        onClose={() => setCreating(false)}
        onCreated={jobs.refresh}
      />
    </>
  );
}
