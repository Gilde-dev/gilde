'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type Project, type Revision } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { useProject } from '@/lib/use-project';
import { NoProjects } from './no-projects';
import { StatusBadge } from './status-badge';
import { Button } from './ui/button';

const POLL_MS = 15_000;
const SELECT = 'h-9 rounded-md border border-input bg-card px-2 text-sm';

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface FieldDiff {
  field: 'Title' | 'Task' | 'Acceptance criteria' | 'Dependencies';
  before: string;
  after: string;
}

/** The fields a revision changes, as before and after text. Null fields in the revision are unchanged. */
export function revisionDiff(r: Revision): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  if (r.title !== null) diffs.push({ field: 'Title', before: r.job.title, after: r.title });
  if (r.task !== null) diffs.push({ field: 'Task', before: r.job.task, after: r.task });
  if (r.acceptanceCriteria !== null) {
    diffs.push({ field: 'Acceptance criteria', before: list(r.job.acceptanceCriteria), after: list(r.acceptanceCriteria) });
  }
  if (r.dependsOn !== null) diffs.push({ field: 'Dependencies', before: list(r.job.dependsOn), after: list(r.dependsOn) });
  return diffs;
}

const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '(none)');

export function ProposalsView() {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { projects, projectId } = useProject();

  const fetchRevisions = useCallback(
    () => (projectId ? api.listRevisions('proposed', projectId) : Promise.resolve([] as Revision[])),
    [projectId],
  );
  const revisions = usePolling(fetchRevisions, POLL_MS);

  async function decide(action: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      await revisions.refresh();
      setBusy(false);
    }
  }

  return (
    <>
        <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <h2 className="font-serif text-lg font-semibold">Proposals</h2>
        </header>
        {projects?.length === 0 && <NoProjects />}
        {(actionError || revisions.error) && (
          <p role="alert" className="px-4 pt-3 text-sm text-danger">{actionError ?? revisions.error?.message}</p>
        )}
        {revisions.loading && !revisions.data && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
        {revisions.data && revisions.data.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">No proposals waiting. Agents propose changes to upcoming jobs in their PR.</p>
        )}
        <ul className="space-y-3 p-4">
          {revisions.data?.map((r) => (
            <ProposalCard
              key={r.id}
              revision={r}
              busy={busy}
              onAccept={() => decide(() => api.acceptRevision(r.id))}
              onReject={() => decide(() => api.rejectRevision(r.id))}
            />
          ))}
        </ul>
    </>
  );
}

function ProposalCard({
  revision: r,
  busy,
  onAccept,
  onReject,
}: {
  revision: Revision;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <li aria-label={r.job.title} className="space-y-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{r.job.title}</h3>
        <StatusBadge status={r.job.status} />
        {r.pr && (
          <a href={r.pr.url} target="_blank" rel="noreferrer" className="text-sm underline">
            Proposed in PR #{r.pr.number}
          </a>
        )}
      </div>
      <p className="whitespace-pre-wrap text-sm">
        <span className="font-semibold">Reason: </span>
        {r.reason}
      </p>
      <div className="space-y-2">
        {revisionDiff(r).map((d) => (
          <div key={d.field}>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{d.field}</h4>
            <div className="mt-1 grid gap-2 md:grid-cols-2">
              <pre aria-label={`${d.field} before`} className="whitespace-pre-wrap rounded-md bg-danger-soft p-2 text-xs text-danger">{d.before}</pre>
              <pre aria-label={`${d.field} after`} className="whitespace-pre-wrap rounded-md bg-success-soft p-2 text-xs text-success">{d.after}</pre>
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={onAccept}>
          Accept
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onReject}>
          Reject
        </Button>
      </div>
    </li>
  );
}
