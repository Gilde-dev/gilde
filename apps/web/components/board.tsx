'use client';

import { useState } from 'react';
import { api, type Feature, type Job, type Repo } from '@/lib/api';
import { errorText, warningLines } from '@/lib/job-actions';
import { LANES, type Lane } from '@/lib/lanes';
import { JobCard } from './job-card';
import { Button } from './ui/button';

function LaneColumn({
  lane,
  jobs,
  repos,
  features,
  ciByJob,
  onOpen,
  onChanged,
  onEnqueued,
}: {
  lane: Lane;
  jobs: Job[];
  repos: Map<string, Repo>;
  features: Map<string, Feature>;
  ciByJob?: Record<string, string | null>;
  onOpen: (job: Job) => void;
  onChanged?: () => void | Promise<void>;
  onEnqueued?: (warnings: string[]) => void;
}) {
  const [collapsed, setCollapsed] = useState(lane.collapsedByDefault ?? false);
  const selectable = lane.key === 'triage';
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    <section aria-label={lane.title} className="flex w-64 shrink-0 flex-col rounded-lg bg-muted/60 p-2">
      <h2 className="flex items-center justify-between px-1 py-1 text-sm font-semibold">
        <span>{lane.title}</span>
        <span className="flex items-center gap-2">
          <span className="text-xs font-normal text-muted-foreground">{jobs.length}</span>
          {lane.collapsedByDefault && (
            <button
              type="button"
              className="text-xs font-normal text-muted-foreground underline"
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((c) => !c)}
            >
              {collapsed ? 'Show' : 'Hide'}
            </button>
          )}
        </span>
      </h2>
      {selectable && jobs.length > 0 && (
        <div className="px-1 pb-1">
          <Button size="sm" disabled={busy || selectedIds.length === 0} onClick={() => void queueSelected()}>
            Queue selected{selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}
          </Button>
          {error && (
            <p role="alert" className="mt-1 text-xs text-danger">
              {error}
            </p>
          )}
        </div>
      )}
      {!collapsed && (
        <div className="mt-1 flex flex-col gap-2">
          {jobs.length === 0 && <p className="px-1 text-xs text-muted-foreground">Nothing here</p>}
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              repoName={repos.get(job.repoId)?.fullName}
              featureTitle={job.featureId ? features.get(job.featureId)?.title : undefined}
              ci={ciByJob?.[job.id]}
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
  ciByJob,
  onOpen,
  onChanged,
  onEnqueued,
}: {
  jobs: Job[];
  repos: Repo[];
  features?: Feature[];
  /** Feature id to show jobs of; '' shows all, 'none' the jobs without a feature. */
  featureFilter?: string;
  /** Latest CI conclusion per job id, when known. */
  ciByJob?: Record<string, string | null>;
  onOpen: (job: Job) => void;
  onChanged?: () => void | Promise<void>;
  onEnqueued?: (warnings: string[]) => void;
}) {
  const repoById = new Map(repos.map((r) => [r.id, r]));
  const featureById = new Map(features.map((f) => [f.id, f]));
  const shown = jobs.filter((j) => (featureFilter === '' ? true : featureFilter === 'none' ? !j.featureId : j.featureId === featureFilter));
  return (
    <div className="flex items-start gap-3 overflow-x-auto p-4">
      {LANES.map((lane) => (
        <LaneColumn
          key={lane.key}
          lane={lane}
          jobs={shown.filter((j) => lane.statuses.includes(j.status))}
          repos={repoById}
          features={featureById}
          ciByJob={ciByJob}
          onOpen={onOpen}
          onChanged={onChanged}
          onEnqueued={onEnqueued}
        />
      ))}
    </div>
  );
}
