'use client';

import { useState } from 'react';
import { api, type IntakeComment } from '@/lib/api';
import { relativeTime } from '@/lib/time';
import { Button } from './ui/button';

export const COLLAPSED_CHARS = 300;

/** The stored member answers of an intake item, as the Verfijner sees them. Bodies are rendered as escaped plain text only. */
export function IntakeAnswers({ itemId }: { itemId: string }) {
  const [comments, setComments] = useState<IntakeComment[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (open) return setOpen(false);
    setOpen(true);
    if (comments) return;
    try {
      setComments((await api.getIntake(itemId)).comments);
      setError(null);
    } catch {
      setError('Could not load the answers.');
    }
  }

  return (
    <div className="mt-2">
      <Button size="sm" variant="outline" aria-expanded={open} onClick={() => void toggle()}>
        {open ? 'Hide answers' : 'Show answers'}
      </Button>
      {open && error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {open && !error && !comments && <p className="mt-2 text-sm text-muted-foreground">Loading…</p>}
      {open && comments && (
        <ul className="mt-2 space-y-2">
          {comments.map((c) => <AnswerRow key={c.id} comment={c} />)}
        </ul>
      )}
    </div>
  );
}

function AnswerRow({ comment: c }: { comment: IntakeComment }) {
  const [expanded, setExpanded] = useState(false);
  const long = c.body.length > COLLAPSED_CHARS;
  return (
    <li className="rounded-md border border-border p-2">
      <div className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
        <span className="font-mono text-foreground">@{c.author}</span>
        <span>{relativeTime(c.createdAt)}</span>
        <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-foreground underline">View on GitHub</a>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-md">{long && !expanded ? `${c.body.slice(0, COLLAPSED_CHARS)}…` : c.body}</p>
      {long && (
        <button type="button" className="mt-1 text-sm text-foreground underline" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </li>
  );
}
