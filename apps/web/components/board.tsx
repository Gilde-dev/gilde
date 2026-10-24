'use client';

import { useState } from 'react';
import type { Job, Repo } from '@/lib/api';
import { LANES, type Lane } from '@/lib/lanes';
import { JobCard } from './job-card';

function LaneColumn({
  lane,
  jobs,
  repos,
  onOpen,
  onChanged,
}: {
  lane: Lane;
  jobs: Job[];
  repos: Map<string, Repo>;
  onOpen: (job: Job) => void;
  onChanged?: () => void | Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState(lane.collapsedByDefault ?? false);
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
      {!collapsed && (
        <div className="mt-1 flex flex-col gap-2">
          {jobs.length === 0 && <p className="px-1 text-xs text-muted-foreground">Nothing here</p>}
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} repoName={repos.get(job.repoId)?.fullName} onOpen={onOpen} onChanged={onChanged} />
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
}: {
  jobs: Job[];
  repos: Repo[];
  onOpen: (job: Job) => void;
  onChanged?: () => void | Promise<void>;
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
        />
      ))}
    </div>
  );
}
