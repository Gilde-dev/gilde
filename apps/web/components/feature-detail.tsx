'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import {
  JOB_STATUSES,
  api,
  type FeatureActionResult,
  type FeatureCancelResult,
  type FeatureDoneResult,
  type FeatureJobRef,
  type FeatureStartResult,
  type Job,
  type Repo,
} from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { usePolling } from '@/lib/use-polling';
import { withProject } from '@/lib/use-project';
import { FeatureProgressBar, ReadyToCloseBadge } from './feature-progress';
import { CopilotPageContext } from './copilot-provider';
import { NewJobDialog } from './new-job-dialog';
import { StatusBadge } from './status-badge';
import { Button } from './ui/button';

const POLL_MS = 5000;

type Action = 'start' | 'done' | 'cancel' | 'reopen';
const CALLS: Record<Action, (id: string) => Promise<FeatureActionResult>> = {
  start: (id) => api.startFeature(id),
  done: (id) => api.doneFeature(id),
  cancel: (id) => api.cancelFeature(id),
  reopen: (id) => api.reopenFeature(id),
};

/** What an action response adds beyond the feature itself, as lines to show. */
export function resultNotes(action: Action, result: FeatureActionResult): { warnings: string[]; lists: { title: string; jobs: FeatureJobRef[] }[] } {
  const warnings = action === 'start' ? (result as FeatureStartResult).warnings.map((w) => w.message) : [];
  const lists: { title: string; jobs: FeatureJobRef[] }[] = [];
  if (action === 'done') {
    lists.push({ title: 'Still open', jobs: (result as FeatureDoneResult).openJobs });
  }
  if (action === 'cancel') {
    const r = result as FeatureCancelResult;
    lists.push({ title: 'Cancelled', jobs: r.cancelledJobs }, { title: 'Left running (not cancelled)', jobs: r.activeJobs });
  }
  return { warnings, lists: lists.filter((l) => l.jobs.length > 0) };
}

export function FeatureDetailView() {
  const { id } = useParams<{ id: string }>();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notes, setNotes] = useState<ReturnType<typeof resultNotes> | null>(null);

  const fetchFeature = useCallback(() => api.getFeature(id), [id]);
  const feature = usePolling(fetchFeature, POLL_MS);
  const projectId = feature.data?.projectId;
  const fetchRepos = useCallback(() => (projectId ? api.listRepos(projectId) : Promise.resolve([] as Repo[])), [projectId]);
  const fetchJobs = useCallback(() => (projectId ? api.listJobs(projectId) : Promise.resolve([] as Job[])), [projectId]);
  const repos = usePolling(fetchRepos, 60_000);
  const projectJobs = usePolling(fetchJobs, 30_000);

  const f = feature.data;
  const repoName = (repoId: string) => repos.data?.find((r) => r.id === repoId)?.fullName ?? repoId;

  async function run(action: Action) {
    setBusy(true);
    setActionError(null);
    setNotes(null);
    try {
      setNotes(resultNotes(action, await CALLS[action](id)));
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      await feature.refresh();
      setBusy(false);
    }
  }

  return (
    <>
      <CopilotPageContext description="The feature page open in the Gilde UI" value={{ featureId: id }} />
        {feature.error && <p role="alert" className="p-4 text-sm text-danger">{feature.error.message}</p>}
        {feature.loading && !f && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
        {f && (
          <>
            <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
              <Link href={withProject('/features', projectId ?? null)} className="text-sm text-muted-foreground underline">
                Features
              </Link>
              <h2 className="font-serif text-lg font-semibold">{f.title}</h2>
              <StatusBadge kind="feature" status={f.status} />
              <ReadyToCloseBadge feature={f} />
              <div className="ml-auto flex items-center gap-2">
                {f.status === 'draft' && (
                  <Button size="sm" disabled={busy} onClick={() => void run('start')}>
                    Start
                  </Button>
                )}
                {f.status === 'active' && (
                  <Button size="sm" disabled={busy} onClick={() => void run('done')}>
                    Done
                  </Button>
                )}
                {f.status === 'done' && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void run('reopen')}>
                    Reopen
                  </Button>
                )}
                {(f.status === 'draft' || f.status === 'active') && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void run('cancel')}>
                    Cancel
                  </Button>
                )}
                {(f.status === 'draft' || f.status === 'active') && (
                  <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
                    Add job
                  </Button>
                )}
              </div>
            </header>
            {actionError && <p role="alert" className="px-4 pt-3 text-sm text-danger">{actionError}</p>}
            {notes && (notes.warnings.length > 0 || notes.lists.length > 0) && (
              <div role="status" className="m-4 rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-warning">
                {notes.warnings.length > 0 && (
                  <ul className="list-disc pl-4">
                    {notes.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
                {notes.lists.map((l) => (
                  <div key={l.title} className="mt-1">
                    <p className="font-medium">{l.title}</p>
                    <ul className="list-disc pl-4">
                      {l.jobs.map((j) => (
                        <li key={j.id}>
                          {j.title} ({j.status})
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                <button type="button" className="mt-1 underline" onClick={() => setNotes(null)}>
                  Dismiss
                </button>
              </div>
            )}
            <div className="space-y-4 p-4">
              <FeatureProgressBar progress={f.progress} />
              <p className="text-xs text-muted-foreground">
                {f.progress.attempts} {f.progress.attempts === 1 ? 'attempt' : 'attempts'}
                {f.progress.leadTimeMinutes !== null && ` · lead time ${f.progress.leadTimeMinutes} min`}
              </p>
              <section aria-label="Spec">
                <h3 className="text-sm font-semibold">Spec</h3>
                {f.spec ? (
                  <pre className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-card p-3 text-sm">{f.spec}</pre>
                ) : (
                  <p className="mt-1 text-sm text-muted-foreground">No spec</p>
                )}
              </section>
              {f.acceptanceCriteria.length > 0 && (
                <section aria-label="Feature criteria">
                  <h3 className="text-sm font-semibold">Acceptance criteria</h3>
                  <ul className="mt-1 list-disc pl-5 text-sm">
                    {f.acceptanceCriteria.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </section>
              )}
              <section aria-label="Jobs">
                <h3 className="text-sm font-semibold">Jobs</h3>
                {f.jobs.length === 0 && <p className="mt-1 text-sm text-muted-foreground">No jobs yet</p>}
                {JOB_STATUSES.filter((s) => f.jobs.some((j) => j.status === s)).map((s) => (
                  <div key={s} className="mt-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {s} ({f.jobs.filter((j) => j.status === s).length})
                    </h4>
                    <ul className="mt-1 space-y-1">
                      {f.jobs
                        .filter((j) => j.status === s)
                        .map((j) => (
                          <li key={j.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
                            <span className="font-medium">{j.title}</span>
                            <span className="text-xs text-muted-foreground">{repoName(j.repoId)}</span>
                            {j.prUrl && j.prNumber !== null && (
                              <a href={j.prUrl} target="_blank" rel="noreferrer" className="text-xs underline">
                                #{j.prNumber}
                              </a>
                            )}
                          </li>
                        ))}
                    </ul>
                  </div>
                ))}
              </section>
            </div>
          </>
        )}
      {f && (
        <NewJobDialog
          open={creating}
          repos={repos.data ?? []}
          jobs={projectJobs.data ?? []}
          featureId={f.id}
          featureTitle={f.title}
          onClose={() => setCreating(false)}
          onCreated={feature.refresh}
        />
      )}
    </>
  );
}
