'use client';

import { Ban, CircleCheck, CirclePause, Clock, Eye, GitPullRequest, Inbox, LoaderCircle, Plus, RotateCcw, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { api, type Feature, type Job, type Repo } from '@/lib/api';
import { errorText, warningLines } from '@/lib/job-actions';
import { LANES, type Lane } from '@/lib/lanes';
import { cn } from '@/lib/utils';
import { JobCard } from './job-card';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';
import { Icon } from './ui/icon';
import { Skeleton } from './ui/skeleton';

/** Lane look: light has a soft semantic tint, dark a raised neutral surface (`dark:bg-lane`). */
const LANE_STYLE: Record<string, { icon: LucideIcon; tint: string; iconColor: string }> = {
  triage: { icon: Inbox, tint: 'bg-muted', iconColor: 'text-muted-foreground' },
  queued: { icon: Clock, tint: 'bg-info-soft', iconColor: 'text-info' },
  running: { icon: LoaderCircle, tint: 'bg-running-soft', iconColor: 'text-running' },
  pr_open: { icon: GitPullRequest, tint: 'bg-pr-soft', iconColor: 'text-pr' },
  awaiting_review: { icon: Eye, tint: 'bg-warning-soft', iconColor: 'text-warning' },
  parked: { icon: CirclePause, tint: 'bg-danger-soft', iconColor: 'text-danger' },
  done: { icon: CircleCheck, tint: 'bg-success-soft', iconColor: 'text-success' },
};
const FALLBACK_STYLE = { icon: Ban, tint: 'bg-muted', iconColor: 'text-muted-foreground' };

function LaneColumn({
  lane,
  jobs,
  repos,
  features,
  onOpen,
  onChanged,
  onEnqueued,
}: {
  lane: Lane;
  jobs: Job[];
  repos: Map<string, Repo>;
  features: Map<string, Feature>;
  onOpen: (job: Job) => void;
  onChanged?: () => void | Promise<void>;
  onEnqueued?: (warnings: string[]) => void;
}) {
  const [collapsed, setCollapsed] = useState(lane.collapsedByDefault ?? false);
  const selectable = lane.key === 'triage';
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const style = LANE_STYLE[lane.key] ?? FALLBACK_STYLE;
  // Jobs that left triage since being picked drop out of the selection.
  const selectedIds = picked.filter((id) => jobs.some((j) => j.id === id));

  async function queueSelected() {
    setBusy(true);
    setError(null);
    try {
      const queued = await api.enqueueJobs(selectedIds);
      setPicked([]);
      onEnqueued?.(warningLines(queued));
      await onChanged?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label={lane.title} className={cn('flex w-72 shrink-0 flex-col rounded-xl p-3 dark:bg-lane', style.tint)}>
      <h2 className="flex items-center justify-between gap-2 px-1 pb-2 text-md font-semibold">
        <span className="flex min-w-0 items-center gap-2">
          <Icon icon={style.icon} className={style.iconColor} />
          <span className="truncate">{lane.title}</span>
        </span>
        <span className="flex items-center gap-2">
          {lane.collapsedByDefault && (
            <button
              type="button"
              className="rounded-sm text-sm font-normal text-muted-foreground underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((c) => !c)}
            >
              {collapsed ? 'Show' : 'Hide'}
            </button>
          )}
          <span className="rounded-full bg-card px-2 text-label text-foreground">{jobs.length}</span>
        </span>
      </h2>
      {selectable && jobs.length > 0 && (
        <div className="px-1 pb-2">
          <Button size="sm" disabled={busy || selectedIds.length === 0} onClick={() => void queueSelected()}>
            Queue selected{selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}
          </Button>
          {error && (
            <p role="alert" className="mt-1 text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      )}
      {!collapsed && (
        <div className="flex flex-col gap-2">
          {jobs.length === 0 && (
            <p className="rounded-lg border border-dashed border-border px-3 py-2 text-center text-sm text-muted-foreground">Nothing here</p>
          )}
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              repoName={repos.get(job.repoId)?.fullName}
              featureTitle={job.featureId ? features.get(job.featureId)?.title : undefined}
              onOpen={onOpen}
              onChanged={onChanged}
              onEnqueued={onEnqueued}
              {...(selectable
                ? {
                    selected: selectedIds.includes(job.id),
                    onSelect: (on: boolean) => setPicked((p) => (on ? [...p, job.id] : p.filter((id) => id !== job.id))),
                  }
                : {})}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function Board({
  jobs,
  repos,
  features = [],
  featureFilter = '',
  loading = false,
  error,
  totalJobs,
  onResetFilters,
  onOpen,
  onChanged,
  onEnqueued,
  onNewJob,
}: {
  /** The jobs to show (after the creator filter, if any). */
  jobs: Job[];
  repos: Repo[];
  features?: Feature[];
  /** Feature id to show jobs of; '' shows all, 'none' the jobs without a feature. */
  featureFilter?: string;
  /** The list has not loaded yet: shows a loading state instead of an empty board. */
  loading?: boolean;
  /** The list could not be loaded and there is nothing to show. */
  error?: string | null;
  /** Size of the loaded, unfiltered list; 0 is a genuinely empty board. Defaults to `jobs.length`. */
  totalJobs?: number;
  /** Clears the display filters; offered when they hide every job. */
  onResetFilters?: () => void;
  onOpen: (job: Job) => void;
  onChanged?: () => void | Promise<void>;
  onEnqueued?: (warnings: string[]) => void;
  /** Makes the empty board's "New job" action available. */
  onNewJob?: () => void;
}) {
  if (loading) {
    return (
      <div role="status" aria-label="Loading jobs" className="flex items-start gap-3 overflow-x-auto p-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-48 w-72 shrink-0 rounded-xl" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-4">
        <EmptyState icon={TriangleAlert} title="Jobs could not be loaded" text={error} />
      </div>
    );
  }
  const repoById = new Map(repos.map((r) => [r.id, r]));
  const featureById = new Map(features.map((f) => [f.id, f]));
  const shown = jobs.filter((j) => (featureFilter === '' ? true : featureFilter === 'none' ? !j.featureId : j.featureId === featureFilter));
  if ((totalJobs ?? jobs.length) === 0) {
    return (
      <div className="p-4">
        <EmptyState
          icon={Inbox}
          title="No jobs yet"
          text="Create a job to put work on the board."
          action={
            onNewJob && (
              <Button icon={Plus} onClick={onNewJob}>
                New job
              </Button>
            )
          }
        />
      </div>
    );
  }
  if (shown.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          icon={Inbox}
          title="No jobs match the filters"
          text="Change or reset the filters to see the project's jobs."
          action={
            onResetFilters && (
              <Button variant="outline" icon={RotateCcw} onClick={onResetFilters}>
                Reset filters
              </Button>
            )
          }
        />
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3 overflow-x-auto p-4">
      {LANES.map((lane) => (
        <LaneColumn
          key={lane.key}
          lane={lane}
          jobs={shown.filter((j) => lane.statuses.includes(j.status))}
          repos={repoById}
          features={featureById}
          onOpen={onOpen}
          onChanged={onChanged}
          onEnqueued={onEnqueued}
        />
      ))}
    </div>
  );
}
