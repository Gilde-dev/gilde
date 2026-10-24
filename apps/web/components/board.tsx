'use client';

import { useState } from 'react';
import { api, type Job, type Repo } from '@/lib/api';
import { errorText, warningLines } from '@/lib/job-actions';
import { LANES, type Lane } from '@/lib/lanes';
import { JobCard } from './job-card';
import { Button } from './ui/button';

function LaneColumn({
  lane,
  jobs,
  repos,
  onOpen,
  onChanged,
  onEnqueued,
}: {
  lane: Lane;
  jobs: Job[];
  repos: Map<string, Repo>;
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
            <p role="alert" className="mt-1 text-xs text-red-800">
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
  onOpen,
  onChanged,
  onEnqueued,
}: {
  jobs: Job[];
  repos: Repo[];
  onOpen: (job: Job) => void;
  onChanged?: () => void | Promise<void>;
  onEnqueued?: (warnings: string[]) => void;
}) {
  const repoById = new Map(repos.map((r) => [r.id, r]));
  return (
    <div className="flex items-start gap-3 overflow-x-auto p-4">
      {LANES.map((lane) => (
        <LaneColumn
          key={lane.key}
          lane={lane}
          jobs={jobs.filter((j) => lane.statuses.includes(j.status))}
          repos={repoById}
          onOpen={onOpen}
          onChanged={onChanged}
          onEnqueued={onEnqueued}
        />
      ))}
    </div>
  );
}
