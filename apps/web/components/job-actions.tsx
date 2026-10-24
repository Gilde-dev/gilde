'use client';

import { useState } from 'react';
import { api, type EnqueueResult, type Job } from '@/lib/api';
import { canCancel, canEnqueue, canRetry, canTriage, errorText, warningLines } from '@/lib/job-actions';
import { Button } from './ui/button';

/** Cancel (with confirm) and Retry buttons for a job; renders nothing for statuses without actions. */
export function JobActions({
  job,
  onChanged,
  onEnqueued,
}: {
  job: Job;
  onChanged: () => void | Promise<void>;
  /** Called with the warning lines after a job was queued. */
  onEnqueued?: (warnings: string[]) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canCancel(job.status) && !canRetry(job.status) && !canEnqueue(job.status) && !canTriage(job.status)) return null;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setConfirming(false);
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-2">
        {canEnqueue(job.status) && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const queued: EnqueueResult = await api.enqueueJob(job.id);
                onEnqueued?.(warningLines([queued]));
              })
            }
          >
            Queue
          </Button>
        )}
        {canTriage(job.status) && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api.triageJob(job.id))}>
            Back to triage
          </Button>
        )}
        {canRetry(job.status) && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api.retryJob(job.id))}>
            Retry
          </Button>
        )}
        {canCancel(job.status) &&
          (confirming ? (
            <>
              <span className="text-xs">Cancel this job?</span>
              <Button size="sm" disabled={busy} onClick={() => void run(() => api.cancelJob(job.id))}>
                Confirm cancel
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
              Cancel
            </Button>
          ))}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-800">
          {error}
        </p>
      )}
    </div>
  );
}
