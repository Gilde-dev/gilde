'use client';

import { useCallback } from 'react';
import { api, type Job, type Run } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { JobActions } from './job-actions';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

function RunRow({ run }: { run: Run }) {
  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Attempt {run.attempt}</span>
        <Badge variant="secondary">{run.status}</Badge>
        {run.ciConclusion && (
          <Badge variant={run.ciConclusion === 'success' ? 'success' : 'danger'}>CI {run.ciConclusion}</Badge>
        )}
        {run.result && (
          <Badge variant={run.result.outcome === 'done' ? 'success' : run.result.outcome === 'blocked' ? 'danger' : 'warning'}>
            {run.result.outcome}
          </Badge>
        )}
        {run.sessionUrl && (
          <a href={run.sessionUrl} target="_blank" rel="noreferrer" className="ml-auto underline">
            Session
          </a>
        )}
      </div>
      {run.result && <p className="mt-2">{run.result.summary}</p>}
      {run.error && <p className="mt-2 text-red-800">{run.error}</p>}
      {run.retro && (
        <details className="mt-2">
          <summary className="cursor-pointer text-muted-foreground">Retro</summary>
          <pre className="mt-1 whitespace-pre-wrap text-xs">{run.retro}</pre>
        </details>
      )}
    </li>
  );
}

export function JobModal({
  job,
  onClose,
  onChanged,
}: {
  job: Job | null;
  onClose: () => void;
  onChanged?: () => void | Promise<void>;
}) {
  const jobId = job?.id;
  const fetchDetail = useCallback(() => (jobId ? api.getJob(jobId) : Promise.resolve(undefined)), [jobId]);
  const { data, error, refresh } = usePolling(fetchDetail, 5000);
  // The board's copy is available immediately; the detail adds runs.
  const shown = data ?? job;

  return (
    <Dialog open={job !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {shown && (
          <div className="space-y-4">
            <div>
              <DialogTitle className="pr-6 text-lg font-semibold">{shown.title}</DialogTitle>
              <DialogDescription asChild>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <Badge>{shown.status}</Badge>
                  {shown.prUrl && (
                    <a href={shown.prUrl} target="_blank" rel="noreferrer" className="underline">
                      PR #{shown.prNumber}
                    </a>
                  )}
                  {shown.branch && <code className="text-xs">{shown.branch}</code>}
                </div>
              </DialogDescription>
            </div>

            <JobActions
              job={shown}
              onChanged={async () => {
                await Promise.all([refresh(), onChanged?.()]);
              }}
            />

            <section>
              <h3 className="text-sm font-semibold">Task</h3>
              <p className="mt-1 whitespace-pre-wrap text-sm">{shown.task}</p>
            </section>

            {shown.acceptanceCriteria.length > 0 && (
              <section>
                <h3 className="text-sm font-semibold">Acceptance criteria</h3>
                <ul className="mt-1 space-y-1 text-sm">
                  {shown.acceptanceCriteria.map((c, i) => (
                    <li key={i} className="flex gap-2">
                      <input type="checkbox" disabled aria-label="criterion" className="mt-1" />
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {shown.lastReason && (
              <section>
                <h3 className="text-sm font-semibold">Last reason</h3>
                <p className="mt-1 whitespace-pre-wrap text-sm">{shown.lastReason}</p>
              </section>
            )}

            <section>
              <h3 className="text-sm font-semibold">Runs</h3>
              {error && <p className="mt-1 text-sm text-red-800">{error.message}</p>}
              {data && data.runs.length === 0 && <p className="mt-1 text-sm text-muted-foreground">No runs yet</p>}
              {!data && !error && <p className="mt-1 text-sm text-muted-foreground">Loading…</p>}
              <ul className="mt-1 space-y-2">
                {data?.runs.map((run) => <RunRow key={run.id} run={run} />)}
              </ul>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
