'use client';

import { useCallback, useState } from 'react';
import { api, type LessonPattern, type LessonPatterns, type ProposeSkillResult } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { Badge } from './ui/badge';
import { withProject } from '@/lib/use-project';
import { ProposeSkillDialog } from './propose-skill-dialog';
import { Button } from './ui/button';

const POLL_MS = 60_000;
const SELECT = 'h-9 rounded-md border border-input bg-card px-2 text-sm';

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const day = (iso: string) => new Date(iso).toLocaleDateString();

/** Recurring lessons grouped by the server. Read-only except for the existing merge, which a human starts. */
export function LessonPatternsPanel({ projectId, onMerged }: { projectId: string; onMerged: () => void }) {
  const fetchPatterns = useCallback(() => api.listLessonPatterns(projectId), [projectId]);
  const patterns = usePolling<LessonPatterns>(fetchPatterns, POLL_MS);

  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-muted-foreground">
        Candidate and approved lessons that say the same thing, grouped by{' '}
        {patterns.data?.method === 'embeddings' ? 'embedding similarity' : 'text similarity'}. Nothing is merged, approved or applied automatically.
      </p>
      {patterns.error && <p role="alert" className="text-sm text-danger">{patterns.error.message}</p>}
      {patterns.loading && !patterns.data && <p className="text-sm text-muted-foreground">Loading…</p>}
      {patterns.data && patterns.data.patterns.length === 0 && (
        <p className="text-sm text-muted-foreground">No patterns yet: no two candidate or approved lessons are similar enough.</p>
      )}
      <ul className="space-y-3">
        {(patterns.data?.patterns ?? []).map((p) => (
          <PatternCard key={p.id} projectId={projectId} pattern={p} onMerged={() => { onMerged(); void patterns.refresh(); }} />
        ))}
      </ul>
    </div>
  );
}

function PatternCard({ projectId, pattern, onMerged }: { projectId: string; pattern: LessonPattern; onMerged: () => void }) {
  const [open, setOpen] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [proposed, setProposed] = useState<ProposeSkillResult | null>(null);
  const applying = pattern.alreadyCovered.find((c) => c.status === 'applying' && c.appliedJobId);
  const became = pattern.alreadyCovered.find((c) => c.status === 'applied' && c.skillName);
  const jobLink = (jobId: string) => withProject(`/?job=${encodeURIComponent(jobId)}`, projectId);
  const representative = pattern.members.find((m) => m.text === pattern.representativeText) ?? pattern.members[0];
  const [target, setTarget] = useState(representative.lessonId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function merge() {
    setBusy(true);
    setError(null);
    try {
      await api.mergeLessons(target, pattern.members.filter((m) => m.lessonId !== target).map((m) => m.lessonId));
      onMerged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li aria-label={pattern.representativeText.slice(0, 60)} className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-sm">{pattern.representativeText}</p>
        <Badge variant="accent">{pattern.size} lessons</Badge>
        <Badge variant="neutral">{pattern.jobIds.length} {pattern.jobIds.length === 1 ? 'job' : 'jobs'}</Badge>
        <Badge variant="neutral">{pattern.repoIds.length} {pattern.repoIds.length === 1 ? 'repo' : 'repos'}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">First seen {day(pattern.firstSeen)} · last seen {day(pattern.lastSeen)}</p>
      {pattern.alreadyCovered.length > 0 && (
        <div className="text-xs text-muted-foreground">
          Already covered:
          <ul className="list-disc pl-5">
            {pattern.alreadyCovered.map((c) => (
              <li key={c.lessonId}>
                {c.text} <Badge variant="success">{c.status}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
      {became && (
        <p className="text-sm">
          Became skill <span className="font-mono">{became.skillName}</span> ·{' '}
          <a className="underline" href={withProject('/skills?tab=impact', projectId)}>See its impact</a>
        </p>
      )}
      {(applying || proposed) && (
        <p className="text-sm">
          Being applied by{' '}
          <a className="underline" href={jobLink((applying?.appliedJobId ?? proposed?.jobId)!)}>
            job {(applying?.appliedJobId ?? proposed?.jobId)!.slice(0, 8)}
          </a>
          {proposed && !applying ? ` (skill ${proposed.skillName})` : ''}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
      {!applying && !proposed && (
        <Button size="sm" variant="outline" onClick={() => setProposing(true)}>
          Propose skill
        </Button>
      )}
      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show'} lessons ({pattern.members.length})
      </Button>
      </div>
      {proposing && (
        <ProposeSkillDialog
          projectId={projectId}
          pattern={pattern}
          onClose={() => setProposing(false)}
          onProposed={(r) => { setProposed(r); onMerged(); }}
        />
      )}
      {open && (
        <>
          <ul className="space-y-2">
            {pattern.members.map((m) => (
              <li key={m.lessonId} className="rounded-md bg-muted/50 p-2 text-xs">
                <div className="mb-1 flex items-center gap-2">
                  <Badge variant="neutral">{m.status}</Badge>
                  <span>{m.text}</span>
                </div>
                <ul className="space-y-1 text-muted-foreground">
                  {m.sources.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-2">
                      <Badge variant="neutral">{s.kind.replace('_', ' ')}</Badge>
                      <span className="font-mono">job {s.jobId.slice(0, 8)}</span>
                      {s.prUrl ? (
                        <a href={s.prUrl} target="_blank" rel="noreferrer" className="underline">PR</a>
                      ) : (
                        <span>no PR</span>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select aria-label="Merge into…" className={SELECT} value={target} onChange={(e) => setTarget(e.target.value)}>
              {pattern.members.map((m) => (
                <option key={m.lessonId} value={m.lessonId}>{m.text.slice(0, 60)}</option>
              ))}
            </select>
            <Button size="sm" variant="outline" disabled={busy} onClick={merge}>
              Merge {pattern.members.length} lessons
            </Button>
            {error && <span role="alert" className="text-danger">{error}</span>}
          </div>
        </>
      )}
    </li>
  );
}
