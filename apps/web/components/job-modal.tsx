'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { api, type Job, type JobStatus, type Run } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { JobActions } from './job-actions';
import { errorText } from '@/lib/job-actions';
import { CopilotPageContext } from './copilot-provider';
import { Button } from './ui/button';
import { StatusBadge } from './status-badge';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

function RunRow({ run }: { run: Run }) {
  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Attempt {run.attempt}</span>
        <Badge variant="neutral">{run.status}</Badge>
        {run.ciConclusion && (
          <Badge variant={run.ciConclusion === 'success' ? 'success' : 'danger'}>CI {run.ciConclusion}</Badge>
        )}
        {run.instructionsVersion && (
          <Badge variant="neutral" title="Agent instructions version">
            Instructions {run.instructionsVersion}
          </Badge>
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
      {run.error && <p className="mt-2 text-danger">{run.error}</p>}
      {run.retro && (
        <details className="mt-2">
          <summary className="cursor-pointer text-muted-foreground">Retro</summary>
          <pre className="mt-1 whitespace-pre-wrap text-xs">{run.retro}</pre>
        </details>
      )}
    </li>
  );
}

const EDITABLE_DEPS: JobStatus[] = ['triage', 'queued'];

/** Title, task and criteria of a triage job; the only status in which they can change. */
function TriageEditor({ job, onChanged }: { job: Job; onChanged: () => void | Promise<void> }) {
  const [title, setTitle] = useState(job.title);
  const [task, setTask] = useState(job.task);
  const [criteria, setCriteria] = useState(job.acceptanceCriteria.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputClass = 'w-full rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground';

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.updateJob(job.id, {
        title,
        task,
        acceptanceCriteria: criteria.split('\n').map((c) => c.trim()).filter(Boolean),
      });
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-2">
      <div>
        <label htmlFor="triage-title" className="text-sm font-semibold">Title</label>
        <input id="triage-title" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <label htmlFor="triage-task" className="text-sm font-semibold">Task</label>
        <textarea id="triage-task" rows={5} className={inputClass} value={task} onChange={(e) => setTask(e.target.value)} />
      </div>
      <div>
        <label htmlFor="triage-criteria" className="text-sm font-semibold">Acceptance criteria (one per line)</label>
        <textarea id="triage-criteria" rows={3} className={inputClass} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save changes'}
      </Button>
    </section>
  );
}

function Dependencies({
  job,
  candidates,
  onChanged,
}: {
  job: Job;
  candidates: Job[];
  onChanged: () => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titles = new Map(candidates.map((c) => [c.id, c]));
  const blocked = new Map(job.blockedBy.map((b) => [b.id, b]));
  const options = candidates.filter(
    (c) => c.id !== job.id && (!['merged', 'rejected', 'cancelled'].includes(c.status) || job.dependsOn.includes(c.id)),
  );

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.setJobDependencies(job.id, selected);
      setEditing(false);
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  if (job.dependsOn.length === 0 && !EDITABLE_DEPS.includes(job.status)) return null;
  return (
    <section>
      <h3 className="text-sm font-semibold">Dependencies</h3>
      {job.dependsOn.length === 0 && <p className="mt-1 text-sm text-muted-foreground">None</p>}
      <ul className="mt-1 space-y-1 text-sm">
        {job.dependsOn.map((depId) => {
          const dep = blocked.get(depId) ?? titles.get(depId);
          return (
            <li key={depId} className="flex items-center gap-2">
              <span>{dep?.title ?? depId}</span>
              <StatusBadge status={dep?.status ?? 'merged'} mergedBlocked={(dep as { mergedBlocked?: boolean } | undefined)?.mergedBlocked} />
            </li>
          );
        })}
      </ul>
      {EDITABLE_DEPS.includes(job.status) && !editing && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => {
            setSelected(job.dependsOn);
            setEditing(true);
          }}
        >
          Edit dependencies
        </Button>
      )}
      {editing && (
        <div className="mt-2 space-y-2">
          <select
            multiple
            aria-label="Dependencies"
            className="w-full rounded-md border border-input bg-card px-2 py-1.5 text-sm"
            value={selected}
            onChange={(e) => setSelected(Array.from(e.target.selectedOptions, (o) => o.value))}
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title} ({o.status})
              </option>
            ))}
          </select>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={saving} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function RevisionHistory({ jobId, revision }: { jobId: string; revision: number }) {
  const fetchRevisions = useCallback(() => api.listJobRevisions(jobId), [jobId]);
  const { data } = usePolling(fetchRevisions, 15_000);
  if (!data?.length) return null;
  return (
    <section>
      <h3 className="text-sm font-semibold">Revisions (current: {revision})</h3>
      <ul className="mt-1 space-y-1 text-sm">
        {data.map((r) => (
          <li key={r.id}>
            <span className="font-medium">{r.status === 'accepted' ? `#${r.revision}` : r.status}</span>
            {' · '}
            {r.reason}
            {r.pr && (
              <>
                {' · '}
                <a href={r.pr.url} target="_blank" rel="noreferrer" className="underline">
                  PR #{r.pr.number}
                </a>
              </>
            )}
            <span className="text-muted-foreground"> · changes {[r.title && 'title', r.task && 'task', r.acceptanceCriteria && 'criteria', r.dependsOn && 'dependencies'].filter(Boolean).join(', ')}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function JobModal({
  job,
  projectJobs = [],
  onClose,
  onChanged,
  onEnqueued,
}: {
  job: Job | null;
  /** Jobs of the same project, to pick dependencies from. */
  projectJobs?: Job[];
  onClose: () => void;
  onChanged?: () => void | Promise<void>;
  onEnqueued?: (warnings: string[]) => void;
}) {
  const jobId = job?.id;
  const fetchDetail = useCallback(() => (jobId ? api.getJob(jobId) : Promise.resolve(undefined)), [jobId]);
  const { data, error, refresh } = usePolling(fetchDetail, 5000);
  // The board's copy is available immediately; the detail adds runs.
  const shown = data ?? job;

  return (
    <Dialog open={job !== null} onOpenChange={(open) => !open && onClose()}>
      {job && <CopilotPageContext description="The job open in the job dialog" value={{ jobId: job.id, title: job.title }} />}
      <DialogContent>
        {shown && (
          <div className="space-y-4">
            <div>
              <DialogTitle className="pr-6 text-lg font-semibold">{shown.title}</DialogTitle>
              <DialogDescription asChild>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <StatusBadge status={shown.status} mergedBlocked={shown.mergedBlocked} />
                  {shown.prUrl && (
                    <a href={shown.prUrl} target="_blank" rel="noreferrer" className="underline">
                      PR #{shown.prNumber}
                    </a>
                  )}
                  {shown.branch && <code className="text-xs">{shown.branch}</code>}
                  <span>
                    Created by {shown.createdBy?.name ?? 'System'} on {new Date(shown.createdAt).toLocaleDateString('en')}
                  </span>
                </div>
              </DialogDescription>
            </div>

            <Link href={`/jobs/${shown.id}`} className="inline-block text-sm underline">
              Open page
            </Link>

            <JobActions
              job={shown}
              onChanged={async () => {
                await Promise.all([refresh(), onChanged?.()]);
              }}
              onEnqueued={onEnqueued}
            />

            {shown.status === 'triage' ? (
              <TriageEditor
                key={shown.id}
                job={shown}
                onChanged={async () => {
                  await Promise.all([refresh(), onChanged?.()]);
                }}
              />
            ) : (
              <section>
                <h3 className="text-sm font-semibold">Task</h3>
                <p className="mt-1 whitespace-pre-wrap text-sm">{shown.task}</p>
              </section>
            )}

            <Dependencies
              key={shown.id}
              job={shown}
              candidates={projectJobs}
              onChanged={async () => {
                await Promise.all([refresh(), onChanged?.()]);
              }}
            />

            {shown.status !== 'triage' && shown.acceptanceCriteria.length > 0 && (
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

            <RevisionHistory jobId={shown.id} revision={shown.revision} />

            <section>
              <h3 className="text-sm font-semibold">Runs</h3>
              {error && <p className="mt-1 text-sm text-danger">{error.message}</p>}
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
