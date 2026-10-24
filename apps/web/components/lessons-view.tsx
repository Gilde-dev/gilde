'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  LESSON_STATUSES,
  LESSON_TARGET_KINDS,
  api,
  type Lesson,
  type LessonStatus,
  type Repo,
  type UpdateLessonInput,
} from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { SidebarNav } from './sidebar-nav';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

const POLL_MS = 30_000;
const SELECT = 'h-9 rounded-md border border-border bg-background px-2 text-sm';

/** Most sources first, then newest. */
export function sortLessons(lessons: Lesson[]): Lesson[] {
  return [...lessons].sort((a, b) => b.sourceCount - a.sourceCount || b.createdAt.localeCompare(a.createdAt));
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function LessonsView() {
  const [projectId, setProjectId] = useState('');
  const [tab, setTab] = useState<LessonStatus>('candidate');
  const [selected, setSelected] = useState<string[]>([]);
  const [mergeTarget, setMergeTarget] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const projects = usePolling(api.listProjects, 60_000);
  useEffect(() => {
    if (!projectId && projects.data?.length) setProjectId(projects.data[0].id);
  }, [projectId, projects.data]);

  const fetchRepos = useCallback(() => (projectId ? api.listRepos(projectId) : Promise.resolve([] as Repo[])), [projectId]);
  const repos = usePolling(fetchRepos, 60_000);
  const fetchLessons = useCallback(() => (projectId ? api.listLessons(projectId) : Promise.resolve([] as Lesson[])), [projectId]);
  const lessons = usePolling(fetchLessons, POLL_MS);

  const all = lessons.data ?? [];
  const counts = Object.fromEntries(LESSON_STATUSES.map((s) => [s, all.filter((l) => l.status === s).length])) as Record<LessonStatus, number>;
  const visible = sortLessons(all.filter((l) => l.status === tab));
  const chosen = visible.filter((l) => selected.includes(l.id));
  const target = chosen.some((l) => l.id === mergeTarget) ? mergeTarget : '';

  async function run(action: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      await lessons.refresh();
      setBusy(false);
    }
  }

  const collect = () =>
    run(async () => {
      const { created } = await api.collectLessons();
      setNotice(created === 0 ? 'Nothing new to collect' : `Collected ${created} new ${created === 1 ? 'lesson' : 'lessons'}`);
    });

  const merge = () =>
    run(async () => {
      await api.mergeLessons(target, chosen.filter((l) => l.id !== target).map((l) => l.id));
      setSelected([]);
      setMergeTarget('');
    }, 'Merged');

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col gap-4 border-r border-border bg-muted/40 p-4">
        <h1 className="text-lg font-bold">Gilde</h1>
        <SidebarNav current="/lessons" />
      </aside>
      <main className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <h2 className="text-lg font-semibold">Lessons</h2>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <select aria-label="Project" className={SELECT} value={projectId} onChange={(e) => { setProjectId(e.target.value); setSelected([]); }}>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={collect} disabled={busy}>
              Collect now
            </Button>
          </div>
        </header>
        <div role="tablist" aria-label="Status" className="flex gap-1 border-b border-border px-4 py-2">
          {LESSON_STATUSES.map((s) => (
            <Button
              key={s}
              role="tab"
              size="sm"
              variant={s === tab ? 'default' : 'outline'}
              aria-selected={s === tab}
              onClick={() => { setTab(s); setSelected([]); }}
            >
              {s} ({counts[s]})
            </Button>
          ))}
        </div>
        {notice && <p role="status" className="px-4 pt-3 text-sm text-muted-foreground">{notice}</p>}
        {(actionError || lessons.error) && <p role="alert" className="px-4 pt-3 text-sm text-red-800">{actionError ?? lessons.error?.message}</p>}
        {lessons.loading && !lessons.data && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
        {(tab === 'candidate' || tab === 'approved') && chosen.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-4 pt-3 text-sm">
            <span>{chosen.length} selected</span>
            <select aria-label="Merge into…" className={SELECT} value={target} onChange={(e) => setMergeTarget(e.target.value)}>
              <option value="">Merge into…</option>
              {chosen.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.text.slice(0, 60)}
                </option>
              ))}
            </select>
            <Button size="sm" variant="outline" onClick={merge} disabled={busy || chosen.length < 2 || !target}>
              Merge
            </Button>
          </div>
        )}
        {lessons.data && visible.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            {all.length === 0 ? 'No lessons yet. Collect them from finished runs and review feedback.' : `No ${tab} lessons.`}
          </p>
        )}
        <ul className="space-y-3 p-4">
          {visible.map((l) => (
            <LessonCard
              key={l.id}
              lesson={l}
              repos={repos.data ?? []}
              busy={busy}
              selectable={tab === 'candidate' || tab === 'approved'}
              selected={selected.includes(l.id)}
              onSelect={(on) => setSelected((cur) => (on ? [...cur, l.id] : cur.filter((x) => x !== l.id)))}
              onUpdate={(input) => run(() => api.updateLesson(l.id, input))}
              onStatus={(action) => run(() => api.setLessonStatus(l.id, action))}
              onApply={() => run(() => api.applyLesson(l.id), 'Apply job created')}
              onMarkApplied={() => run(() => api.markLessonApplied(l.id))}
            />
          ))}
        </ul>
      </main>
    </div>
  );
}

function LessonCard({
  lesson,
  repos,
  busy,
  selectable,
  selected,
  onSelect,
  onUpdate,
  onStatus,
  onApply,
  onMarkApplied,
}: {
  lesson: Lesson;
  repos: Repo[];
  busy: boolean;
  selectable: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onUpdate: (input: UpdateLessonInput) => void;
  onStatus: (action: 'approve' | 'reject' | 'reopen') => void;
  onApply: () => void;
  onMarkApplied: () => void;
}) {
  const [text, setText] = useState(lesson.text);
  const [note, setNote] = useState(lesson.note ?? '');
  const [open, setOpen] = useState(false);
  useEffect(() => setText(lesson.text), [lesson.text, lesson.updatedAt]);
  useEffect(() => setNote(lesson.note ?? ''), [lesson.note, lesson.updatedAt]);

  const saveText = () => {
    if (text.trim() && text !== lesson.text) onUpdate({ text });
    else setText(lesson.text);
  };
  const saveNote = () => {
    if (note !== (lesson.note ?? '')) onUpdate({ note: note.trim() === '' ? null : note });
  };

  const locked = lesson.status === 'applying' || lesson.status === 'applied';
  const canApply = (lesson.targetKind === 'skill' || lesson.targetKind === 'agents_md') && !!lesson.targetRepoId;

  return (
    <li aria-label={lesson.text.slice(0, 60)} className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-start gap-2">
        {selectable && (
          <input type="checkbox" aria-label="Select lesson" className="mt-2" checked={selected} onChange={(e) => onSelect(e.target.checked)} />
        )}
        <textarea
          aria-label="Lesson text"
          className="min-h-[3rem] flex-1 rounded-md border border-border bg-background p-2 text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={saveText}
        />
        <Badge variant="secondary" title="Distinct jobs behind this lesson">
          {lesson.sourceCount} {lesson.sourceCount === 1 ? 'job' : 'jobs'}
        </Badge>
      </div>
      <div>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'} sources ({lesson.sources.length})
        </Button>
        {open && (
          <ul className="mt-1 space-y-2">
            {lesson.sources.map((s) => (
              <li key={s.id} className="rounded-md bg-muted/50 p-2 text-xs">
                <div className="mb-1 flex items-center gap-2 text-muted-foreground">
                  <Badge variant="outline">{s.kind.replace('_', ' ')}</Badge>
                  {s.prUrl ? (
                    <a href={s.prUrl} target="_blank" rel="noreferrer" className="underline">
                      PR
                    </a>
                  ) : (
                    <span>no PR</span>
                  )}
                </div>
                <p className="whitespace-pre-wrap">{s.excerpt}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Target kind"
          className={SELECT}
          value={lesson.targetKind ?? ''}
          onChange={(e) => onUpdate({ targetKind: (e.target.value || null) as Lesson['targetKind'] })}
        >
          <option value="">Target kind…</option>
          {LESSON_TARGET_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select
          aria-label="Target repo"
          className={SELECT}
          value={lesson.targetRepoId ?? ''}
          onChange={(e) => onUpdate({ targetRepoId: e.target.value || null })}
        >
          <option value="">Target repo…</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.fullName}
            </option>
          ))}
        </select>
        <input
          aria-label="Note"
          placeholder="Note"
          className="h-9 min-w-[10rem] flex-1 rounded-md border border-border bg-background px-2 text-sm"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveNote}
        />
        {lesson.status === 'candidate' && (
          <Button size="sm" disabled={busy} onClick={() => onStatus('approve')}>
            Approve
          </Button>
        )}
        {lesson.status === 'approved' && (
          <>
            <Button size="sm" disabled={busy || !canApply} onClick={onApply} title={canApply ? undefined : 'Needs a skill or agents_md target kind and a target repo'}>
              Apply
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={onMarkApplied}>
              Mark applied
            </Button>
          </>
        )}
        {locked && (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            {lesson.appliedJobId && <span>Job {lesson.appliedJobId.slice(0, 8)}</span>}
            {lesson.appliedJobPrUrl && (
              <a href={lesson.appliedJobPrUrl} target="_blank" rel="noreferrer" className="underline">
                PR
              </a>
            )}
            {lesson.appliedAt && <span>Applied {new Date(lesson.appliedAt).toLocaleString()}</span>}
          </span>
        )}
        {lesson.status !== 'rejected' && !locked && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onStatus('reject')}>
            Reject
          </Button>
        )}
        {lesson.status !== 'candidate' && !locked && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onStatus('reopen')}>
            Reopen
          </Button>
        )}
      </div>
    </li>
  );
}
