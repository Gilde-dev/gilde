'use client';

import { useState } from 'react';
import { api, type EnqueueResult, type Job } from '@/lib/api';
import { canCancel, canEnqueue, canRetry, canSendBack, canTriage, errorText, warningLines } from '@/lib/job-actions';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

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
  const [sendingBack, setSendingBack] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canCancel(job.status) && !canRetry(job.status) && !canEnqueue(job.status) && !canTriage(job.status) && !canSendBack(job.status)) return null;

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
        {canSendBack(job.status) && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setSendingBack(true)}>
            Send back to agent
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
      <Dialog open={sendingBack} onOpenChange={(o) => !o && !busy && setSendingBack(false)}>
        <DialogContent>
          <DialogTitle className="text-lg font-semibold">Send back to agent</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            The agent continues on the existing PR and gets your reason as instructions. This uses one attempt.
          </DialogDescription>
          <label htmlFor="send-back-reason" className="mt-4 block text-sm font-medium">
            Reason
          </label>
          <textarea
            id="send-back-reason"
            rows={5}
            maxLength={4000}
            className="mt-1 w-full rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {error && (
            <p role="alert" className="mt-2 text-xs text-danger">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => setSendingBack(false)}>
              Close
            </Button>
            <Button
              disabled={busy || !reason.trim()}
              onClick={() =>
                void run(async () => {
                  await api.sendBackJob(job.id, reason.trim());
                  setSendingBack(false);
                  setReason('');
                })
              }
            >
              Send back
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {error && !sendingBack && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
