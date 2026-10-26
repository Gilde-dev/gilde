'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Job, Repo, Revision } from '@/lib/api';
import { dependencyLevels } from '@/lib/feature-jobs';
import { relativeTime } from '@/lib/time';
import { withProject } from '@/lib/use-project';
import { StatusBadge } from './status-badge';
import { Button } from './ui/button';

function JobRow({ job, repoName, titles, projectId }: { job: Job; repoName: string; titles: Map<string, string>; projectId: string | null }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-card px-3 py-2 text-sm">
      <StatusBadge status={job.status} />
      <span className="font-mono text-xs text-muted-foreground">{repoName}</span>
      <Link href={withProject(`/jobs/${job.id}`, projectId)} className="font-medium underline-offset-2 hover:underline">
        {job.title}
      </Link>
      {job.dependsOn.length > 0 && (
        <span className="text-xs text-muted-foreground">after {job.dependsOn.map((d) => titles.get(d) ?? d.slice(0, 8)).join(', ')}</span>
      )}
      {job.prUrl && job.prNumber !== null && (
        <a href={job.prUrl} target="_blank" rel="noreferrer" className="ml-auto text-xs underline">
          PR #{job.prNumber}
        </a>
      )}
    </li>
  );
}

export function FeatureJobsTab({ jobs, repos, projectId }: { jobs: Job[]; repos: Repo[]; projectId: string | null }) {
  const [groupBy, setGroupBy] = useState<'level' | 'repo'>('level');
  const repoName = (id: string) => repos.find((r) => r.id === id)?.fullName ?? id;
  const titles = new Map(jobs.map((j) => [j.id, j.title]));
  const { levels, cyclic, notes } = dependencyLevels(jobs);

  const groups: { key: string; title: string; jobs: Job[] }[] =
    groupBy === 'level'
      ? [
          ...levels.map((l, i) => ({ key: `level-${i}`, title: `${i + 1}. ${i === 0 ? 'No dependencies' : `After step ${i}`}`, jobs: l ?? [] })),
          ...(cyclic.length > 0 ? [{ key: 'cycle', title: 'Dependency cycle', jobs: cyclic }] : []),
        ]
      : [...new Set(jobs.map((j) => j.repoId))].map((id) => ({ key: id, title: repoName(id), jobs: jobs.filter((j) => j.repoId === id) }));

  return (
    <section aria-label="Jobs" className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Group by</span>
        <Button size="sm" variant={groupBy === 'level' ? 'primary' : 'outline'} aria-pressed={groupBy === 'level'} onClick={() => setGroupBy('level')}>
          Dependency order
        </Button>
        <Button size="sm" variant={groupBy === 'repo' ? 'primary' : 'outline'} aria-pressed={groupBy === 'repo'} onClick={() => setGroupBy('repo')}>
          Repo
        </Button>
      </div>
      {notes.length > 0 && (
        <div role="note" className="rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-warning">
          {notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
      {jobs.length === 0 && <p className="text-sm text-muted-foreground">No jobs yet</p>}
      {groups
        .filter((g) => g.jobs.length > 0)
        .map((g) => (
          <div key={g.key}>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {g.title} ({g.jobs.length})
            </h4>
            <ul className="mt-1 space-y-1">
              {g.jobs.map((j) => (
                <JobRow key={j.id} job={j} repoName={repoName(j.repoId)} titles={titles} projectId={projectId} />
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}

interface ActivityEntry {
  key: string;
  at: string;
  text: string;
}

/** Newest first: PRs opened and merged (from the jobs, timed by their last update) and revisions. */
export function activityEntries(jobs: Job[], revisions: Revision[]): ActivityEntry[] {
  const ids = new Set(jobs.map((j) => j.id));
  const entries: ActivityEntry[] = [];
  for (const j of jobs) {
    if (j.prNumber === null) continue;
    const merged = j.status === 'merged';
    entries.push({ key: `pr-${j.id}`, at: j.updatedAt, text: `PR #${j.prNumber} ${merged ? 'merged' : 'opened'}: ${j.title}` });
  }
  for (const r of revisions.filter((rev) => ids.has(rev.jobId))) {
    entries.push({ key: `rev-${r.id}`, at: r.decidedAt ?? r.createdAt, text: `Revision ${r.status} for ${r.job.title}: ${r.reason}` });
  }
  return entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

export function FeatureActivityTab({ jobs, revisions }: { jobs: Job[]; revisions: Revision[] }) {
  const entries = activityEntries(jobs, revisions);
  return (
    <section aria-label="Activity">
      {entries.length === 0 && <p className="text-sm text-muted-foreground">No activity yet</p>}
      <ul className="space-y-1">
        {entries.map((e) => (
          <li key={e.key} className="flex gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm">
            <span className="w-24 shrink-0 text-xs text-muted-foreground">{relativeTime(e.at)}</span>
            <span>{e.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
