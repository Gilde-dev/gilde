'use client';

import { useCallback, useState, type FormEvent } from 'react';
import { ADDITION_AGENTS, api, type AdditionAgent, type AgentInstruction, type AgentInstructionVersion, type ApiError } from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { usePolling } from '@/lib/use-polling';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Field } from './ui/field';
import { Skeleton } from './ui/skeleton';
import { Textarea } from './ui/textarea';

const POLL_MS = 60_000;

const LABEL: Record<AdditionAgent, string> = {
  gilde: 'Co-pilot',
  verkenner: 'Verkenner',
  verfijner: 'Verfijner',
  werkmeester: 'Werkmeester',
  reviewer: 'Reviewer',
};

/** A plain-text line diff of two versions: removed lines with `-`, added lines with `+`, unchanged lines with two spaces. Never markup. */
export function textDiff(before: string, after: string): string {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  // Longest common subsequence; additions are short (a few thousand characters), so the quadratic table is fine.
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out.join('\n');
}

function History({ projectId, agentId, version }: { projectId: string; agentId: AdditionAgent; version: number }) {
  const load = useCallback(() => api.getAgentInstructionHistory(projectId, agentId), [projectId, agentId, version]);
  const { data, error, loading } = usePolling(load, POLL_MS);
  if (loading && !data) return <Skeleton className="h-8" />;
  if (error && !data) return <p role="alert" className="text-sm text-danger">{errorText(error)}</p>;
  if (!data || data.length === 0) return <p className="text-sm text-muted-foreground">No versions yet.</p>;
  const previous = (v: AgentInstructionVersion) => data.find((d) => d.version === v.version - 1)?.text ?? '';
  return (
    <ol aria-label={`${LABEL[agentId]} version history`} className="space-y-2">
      {data.map((v) => (
        <li key={v.version} className="space-y-1 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold">Version {v.version}</span>
            {v.current && <Badge variant="success">Current</Badge>}
            {v.text === '' && <Badge variant="neutral">Removed</Badge>}
            <span className="text-muted-foreground">
              {v.updatedBy.name ?? v.updatedBy.email ?? 'Unknown user'} ·{' '}
              <time dateTime={v.updatedAt}>{new Date(v.updatedAt).toLocaleString()}</time>
            </span>
          </div>
          <pre aria-label={`Changes in version ${v.version}`} tabIndex={0} className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-sm">
            {textDiff(previous(v), v.text) || '(empty)'}
          </pre>
        </li>
      ))}
    </ol>
  );
}

function AgentEditor({ projectId, item, maxChars, canEdit, onSaved }: { projectId: string; item: AgentInstruction; maxChars: number; canEdit: boolean; onSaved: () => void | Promise<void> }) {
  const [text, setText] = useState(item.text);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [showHistory, setShowHistory] = useState(false);
  const label = LABEL[item.agentId];
  const over = text.trim().length > maxChars;
  const dirty = text.trim() !== item.text;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.replaceAgentInstruction(projectId, item.agentId, text);
      setText(next.text);
      await onSaved();
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} aria-label={`${label} instructions`} className="max-w-2xl space-y-2 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-md font-semibold">{label}</h3>
        <Badge variant={item.version > 0 && item.text !== '' ? 'accent' : 'neutral'}>
          {item.version > 0 && item.text !== '' ? `Version ${item.version}` : 'No addition'}
        </Badge>
      </div>
      <Field label={`Additional instructions for ${label}`} path="text" error={error} hint="Appended to the agent's base instructions for runs in this project. The base always wins.">
        <Textarea value={text} onChange={(e) => { setText(e.target.value); setSaved(false); }} readOnly={!canEdit} rows={6} aria-invalid={over} />
      </Field>
      <p className={`text-sm ${over ? 'text-danger' : 'text-muted-foreground'}`}>
        <span aria-label={`${label} character count`}>
          {text.trim().length.toLocaleString('en')} / {maxChars.toLocaleString('en')} characters
        </span>
      </p>
      {error != null && (error as ApiError).issues?.length === 0 && <p role="alert" className="text-sm text-danger">{errorText(error)}</p>}
      {saved && !error && <p role="status" className="text-sm text-success">Saved. Runs started from now on use it.</p>}
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <Button type="submit" disabled={busy || over || !dirty}>
            {busy ? 'Saving…' : text.trim() === '' && item.text !== '' ? 'Remove addition' : 'Save'}
          </Button>
        )}
        <Button type="button" variant="ghost" aria-expanded={showHistory} onClick={() => setShowHistory((s) => !s)}>
          {showHistory ? 'Hide history' : 'Version history'}
          <span className="sr-only"> of {label}</span>
        </Button>
      </div>
      {showHistory && <History projectId={projectId} agentId={item.agentId} version={item.version} />}
    </form>
  );
}

/** Project settings tab: one textarea per agent. Admins edit; everyone else reads. Coding agents have none (their guidance is AGENTS.md). */
export function AgentInstructionsTab({ projectId }: { projectId: string }) {
  const load = useCallback(() => api.getAgentInstructions(projectId), [projectId]);
  const { data, error, loading, refresh } = usePolling(load, POLL_MS);
  const me = usePolling(api.me, 300_000);
  const canEdit = me.data?.isAdmin === true;
  if (loading && !data) return <Skeleton className="h-32" />;
  if (error && !data) {
    return (
      <div role="alert" className="flex items-center gap-3 text-sm text-danger">
        <span>{errorText(error)}</span>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>Retry</Button>
      </div>
    );
  }
  if (!data) return null;
  return (
    <div className="space-y-4">
      <p className="max-w-prose text-sm text-muted-foreground">
        Project context, focus and terminology for Gilde&apos;s own agents, added after their base instructions in runs of this project. The base
        instructions always win, and an addition cannot change tools, limits or settings. Coding agents are not covered: their repo guidance is AGENTS.md.
      </p>
      {me.data && !canEdit && <p role="note" className="rounded-lg border border-border bg-muted p-3 text-sm text-muted-foreground">Only admins can change agent instructions.</p>}
      {ADDITION_AGENTS.map((agentId) => {
        const item = data.agents.find((a) => a.agentId === agentId);
        return item ? <AgentEditor key={`${agentId}:${item.version}`} projectId={projectId} item={item} maxChars={data.maxChars} canEdit={canEdit} onSaved={refresh} /> : null;
      })}
    </div>
  );
}
