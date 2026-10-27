'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Job } from '@/lib/api';
import { useProject } from '@/lib/use-project';
import { usePolling } from '@/lib/use-polling';
import { boardStats } from '@/lib/job-stats';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { NewJobDialog } from './new-job-dialog';
import { PauseToggle } from './pause-toggle';
import { PageHeader } from './ui/page-header';
import { Select } from './ui/select';
import { StatCard } from './ui/stat-card';
import { Board } from './board';
import { DispatchStrip } from './dispatch-strip';
import { JobModal } from './job-modal';
import { CopilotPageContext } from './copilot-provider';
import { NoProjects } from './no-projects';

const POLL_MS = 5000;
/** The most jobs api.listJobs returns; the board and its counts cover at most this many. */
const LOADED_LIMIT = 200;
const fetchMe = () => api.me();
/** The scout user changes only with the server's configuration. */
const SCOUT_POLL_MS = 5 * 60_000;

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
  // Always the unfiltered list: the counts must not depend on the display filters.
  const fetchJobs = useCallback(() => (projectId ? api.listJobs(projectId) : Promise.resolve([])), [projectId]);
  const fetchFeatures = useCallback(() => (projectId ? api.listFeatures(projectId) : Promise.resolve([])), [projectId]);
  const repos = usePolling(fetchRepos, POLL_MS);
  const features = usePolling(fetchFeatures, POLL_MS);
  const jobs = usePolling(fetchJobs, POLL_MS);
  const dispatch = usePolling(api.getDispatchStatus, POLL_MS);
  const me = usePolling(fetchMe, 5 * 60_000);
  // One read for the whole board: who the scout is. If it fails, only the "Suggested" badge is missing.
  const fetchScout = useCallback(() => (projectId ? api.scoutActivity(projectId) : Promise.resolve(null)), [projectId]);
  const scout = usePolling(fetchScout, SCOUT_POLL_MS);

  const loadedJobs = (jobs.data ?? []).filter((j) => j.projectId === projectId);
  const jobsLoading = jobs.data === undefined && jobs.error === null;
  const jobsFailed = jobs.data === undefined && jobs.error !== null;
  const creatorPending = creatorFilter === 'me' && me.data === undefined;
  const creatorFailed = creatorPending && me.error !== null;
  // Display subset only; the counts above come from loadedJobs.
  const displayJobs = creatorFilter === 'me' && me.data ? loadedJobs.filter((j) => j.createdBy?.id === me.data!.id) : loadedJobs;
  const stats = boardStats(loadedJobs);
  const statValue = (n: number) => (jobsFailed ? '–' : jobsLoading ? '…' : n);
  const statHint = jobsFailed ? 'Could not load' : jobsLoading ? 'Loading' : undefined;
  const filtersActive = featureFilter !== '' || creatorFilter !== '';
  const resetFilters = () => {
    setFeatureFilter('');
    setCreatorFilter('');
  };

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
      {jobs.error && jobs.data !== undefined && <p className="p-4 text-sm text-danger">{jobs.error.message}</p>}
      {repos.error && <p className="p-4 text-sm text-danger">{repos.error.message}</p>}
      {projects.projects?.length === 0 && <NoProjects />}
      {project && (
        <PageHeader
          className="px-4 pt-4"
          title={project.name}
          description={
            <>
              {repos.data && repos.data.length > 0 ? <span className="font-mono">{repos.data.map((r) => r.fullName).join(', ')}</span> : 'No repos yet'}
              {project.paused && ' · Paused'}
            </>
          }
          actions={
            <>
              <PauseToggle
                paused={project.paused}
                label={`project ${project.name}`}
                toggle={(paused) => api.setProjectPaused(project.id, paused)}
                onChanged={refreshAll}
              />
              <Button icon={Plus} onClick={() => setCreating(true)}>
                New job
              </Button>
            </>
          }
        />
      )}
      {projectId && (
        <section aria-label="Job counts" className="px-4 pt-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="In progress" value={statValue(stats.inProgress)} hint={statHint} />
            <StatCard label="Awaiting review" value={statValue(stats.awaitingReview)} hint={statHint} />
            <StatCard label="Triage (waiting for you)" value={statValue(stats.triage)} hint={statHint} />
            <StatCard label="Needs attention" value={statValue(stats.needsAttention)} hint={statHint} />
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Counts cover the jobs loaded for this project, up to {LOADED_LIMIT}, regardless of the filters below
            {loadedJobs.length >= LOADED_LIMIT ? '. The list is at its limit, so older jobs are not counted' : ''}.
          </p>
        </section>
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
        <div className="flex flex-wrap items-center gap-2 px-4 pt-4">
          <Select
            aria-label="Feature filter"
            className="h-9 w-auto max-w-56"
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
          </Select>
          <div role="group" aria-label="Created by filter" className="inline-flex gap-1 rounded-full bg-muted p-1">
            {([['', 'Anyone'], ['me', 'Me']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={creatorFilter === value}
                onClick={() => setCreatorFilter(value)}
                className={cn(
                  'rounded-full px-3 py-1 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  creatorFilter === value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {filtersActive && (
            <Button variant="ghost" size="sm" onClick={resetFilters}>
              Reset filters
            </Button>
          )}
        </div>
      )}
      {projectId && (
        <Board
          jobs={displayJobs}
          totalJobs={loadedJobs.length}
          repos={repos.data ?? []}
          features={features.data ?? []}
          featureFilter={featureFilter}
          scoutUserId={scout.data?.scoutUserId ?? null}
          loading={jobsLoading || (creatorPending && !creatorFailed)}
          error={jobsFailed ? jobs.error!.message : creatorFailed ? 'Your user could not be loaded to filter on "Me".' : null}
          onResetFilters={filtersActive ? resetFilters : undefined}
          onOpen={setSelected}
          onChanged={jobs.refresh}
          onEnqueued={setWarnings}
          onNewJob={() => setCreating(true)}
        />
      )}
      {projectId && <CopilotPageContext description="The project selected in the Gilde UI" value={{ projectId }} />}
      <JobModal job={selected} projectJobs={loadedJobs} onClose={closeJob} onChanged={jobs.refresh} onEnqueued={setWarnings} />
      <NewJobDialog
        open={creating}
        repos={repos.data ?? []}
        jobs={loadedJobs}
        onClose={() => setCreating(false)}
        onCreated={jobs.refresh}
      />
    </>
  );
}
