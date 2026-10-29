'use client';

import { Inbox } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { api, INTAKE_STATUSES, type IntakeItem, type IntakeStatus } from '@/lib/api';
import { humanOnlyErrorText } from '@/lib/job-actions';
import { relativeTime } from '@/lib/time';
import { usePolling } from '@/lib/use-polling';
import { useProject, withProject } from '@/lib/use-project';
import { ArchiveAction, ArchivedBadge } from './archive-dialog';
import { NoProjects } from './no-projects';
import { IntakeStatusBadge, INTAKE_STATUS_BADGE } from './status-badge';
import { SpecStatusBadge } from './spec-detail';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { EmptyState } from './ui/empty-state';
import { PageHeader } from './ui/page-header';
import { Select } from './ui/select';
import { Skeleton } from './ui/skeleton';

const POLL_MS = 10_000;
export const README_REFINE_URL = 'https://github.com/Gilde-dev/gilde#verfijner-refine-agent';

export const canRetry = (s: IntakeStatus) => s === 'failed' || s === 'ignored';
export const canIgnore = (s: IntakeStatus) => s === 'new' || s === 'drafted' || s === 'failed';

export function IntakeView() {
  const { projects, projectId } = useProject();
  const [filter, setFilter] = useState<IntakeStatus | ''>('');
  const [archived, setArchived] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  const fetchItems = useCallback(() => (projectId ? api.listIntake(projectId, undefined, archived) : Promise.resolve([] as IntakeItem[])), [projectId, archived]);
  const items = usePolling(fetchItems, POLL_MS);
  const status = usePolling(api.copilotStatus, 60_000);
  const refineOff = status.data ? !status.data.refine?.enabled : false;
  const shown = items.data?.filter((i) => !filter || i.status === filter);

  async function act(key: string, what: string, run: () => Promise<string | void>) {
    setBusy(key);
    setNote(null);
    try {
      const text = await run();
      if (text) setNote({ text, error: false });
    } catch (e) {
      setNote({ text: humanOnlyErrorText(e, what), error: true });
    } finally {
      await items.refresh();
      setBusy(null);
    }
  }

  const sweep = () =>
    act('sweep', 'sweep for intake items', async () => {
      const r = await api.sweepIntake();
      return `Swept ${r.repos} repos (${r.skipped} skipped): ${r.upserted} items created or changed, ${r.withdrawn} withdrawn.`;
    });

  return (
    <>
      <PageHeader
        className="px-4 pt-4"
        title="Intake"
        description="GitHub issues labelled gilde:refine, waiting to become draft specs."
        actions={
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void sweep()}>
            {busy === 'sweep' ? 'Sweeping…' : 'Sweep now'}
          </Button>
        }
      />
      {projects?.length === 0 && <NoProjects />}
      {refineOff && (
        <p role="status" className="mx-4 mt-3 rounded-lg border border-border bg-warning-soft p-3 text-sm text-warning">
          The Verfijner (refine agent) is not enabled, so issues are collected but not refined into specs.{' '}
          <a href={README_REFINE_URL} target="_blank" rel="noopener noreferrer" className="underline">
            How to enable it
          </a>
        </p>
      )}
      {note && (
        <p role={note.error ? 'alert' : 'status'} className={`px-4 pt-3 text-sm ${note.error ? 'text-danger' : 'text-muted-foreground'}`}>
          {note.text}
        </p>
      )}
      <div className="flex items-center gap-2 px-4 pt-3 text-sm">
        <label htmlFor="intake-status" className="text-muted-foreground">Status</label>
        <Select id="intake-status" className="h-9 w-auto text-sm" value={filter} onChange={(e) => setFilter(e.target.value as IntakeStatus | '')}>
          <option value="">All</option>
          {INTAKE_STATUSES.map((s) => (
            <option key={s} value={s}>{INTAKE_STATUS_BADGE[s].label}</option>
          ))}
        </Select>
        <label className="ml-2 flex items-center gap-2">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          Archived
        </label>
      </div>
      {items.error && (
        <div role="alert" className="flex items-center gap-3 px-4 pt-3 text-sm text-danger">
          <span>{items.error.message}</span>
          <Button size="sm" variant="outline" onClick={() => void items.refresh()}>Retry</Button>
        </div>
      )}
      {items.loading && !items.data && !items.error && (
        <div aria-label="Loading intake" className="space-y-2 p-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      )}
      {items.data?.length === 0 && (
        <div className="p-4">
          <EmptyState
            icon={Inbox}
            title={archived ? 'No archived intake items' : 'No intake items'}
            text={archived ? 'Archived intake items show up here.' : 'Label a GitHub issue in a registered repo with gilde:refine and it shows up here, then becomes a draft spec.'}
          />
        </div>
      )}
      {items.data && items.data.length > 0 && shown?.length === 0 && (
        <div className="p-4">
          <EmptyState title="No items with this status" action={<Button size="sm" variant="outline" onClick={() => setFilter('')}>Show all</Button>} />
        </div>
      )}
      <ul className="space-y-2 p-4">
        {shown?.map((i) => (
          <li key={i.id}>
            <IntakeCard item={i} projectId={projectId} busy={busy !== null}
              onRetry={() => void act(i.id, 'retry intake items', async () => { await api.retryIntake(i.id); })}
              onIgnore={() => void act(i.id, 'ignore intake items', async () => { await api.ignoreIntake(i.id); })}
              onArchiveChanged={() => void items.refresh()}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

function IntakeCard({ item: i, projectId, busy, onRetry, onIgnore, onArchiveChanged }: {
  item: IntakeItem; projectId: string | null; busy: boolean; onRetry: () => void; onIgnore: () => void; onArchiveChanged: () => void;
}) {
  return (
    <Card className="p-3">
      <div className="flex flex-wrap items-center gap-2">
        <a href={i.url} target="_blank" rel="noopener noreferrer" className="text-md font-semibold underline-offset-2 hover:underline">
          #{i.number} {i.title}
        </a>
        <IntakeStatusBadge status={i.status} />
        {i.archivedAt && <ArchivedBadge />}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="font-mono">{i.repoFullName ?? 'unknown repo'}</span>
        <span>Opened {relativeTime(i.createdAt)}</span>
        {i.spec && (
          <span className="flex flex-wrap items-center gap-2">
            <Link href={withProject(`/specs/${i.spec.id}`, projectId)} className="text-foreground underline">{i.spec.title}</Link>
            <SpecStatusBadge spec={i.spec} />
            {i.spec.openQuestions > 0 && (
              <Badge variant="warning">{i.spec.openQuestions} open {i.spec.openQuestions === 1 ? 'question' : 'questions'}</Badge>
            )}
          </span>
        )}
        {i.statusCommentUrl && (
          <a href={i.statusCommentUrl} target="_blank" rel="noopener noreferrer" className="text-foreground underline">Status comment posted</a>
        )}
        {i.commentCount > 0 && <span>{i.commentCount} {i.commentCount === 1 ? 'answer' : 'answers'} from members</span>}
      </div>
      {i.commentError && <p className="mt-2 break-words text-sm text-warning">Status comment not posted: {i.commentError}</p>}
      {i.lastError && <p className="mt-2 break-words text-sm text-danger">Last error: {i.lastError}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!i.archivedAt && canRetry(i.status) && <Button size="sm" variant="outline" disabled={busy} onClick={onRetry}>Retry</Button>}
        {!i.archivedAt && canIgnore(i.status) && <Button size="sm" variant="outline" disabled={busy} onClick={onIgnore}>Ignore</Button>}
        <ArchiveAction
          archived={!!i.archivedAt}
          noun="intake item"
          consequence={i.spec ? 'Its spec is archived with it, unless a feature has pinned that spec. It is not refined and its issue comment is not updated until you unarchive it.' : 'It is not refined and its issue comment is not updated until you unarchive it.'}
          disabled={busy}
          onArchive={async () => { await api.archiveIntake(i.id); onArchiveChanged(); }}
          onUnarchive={async () => { await api.unarchiveIntake(i.id); onArchiveChanged(); }}
          errorText={humanOnlyErrorText}
        />
      </div>
    </Card>
  );
}
