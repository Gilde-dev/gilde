'use client';

import { Archive } from 'lucide-react';
import { useState } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

export function ArchivedBadge({ className }: { className?: string }) {
  return <Badge variant="neutral" icon={Archive} className={className}>Archived</Badge>;
}

/**
 * Archive / Unarchive for a spec or an intake item. Archiving asks for confirmation (it hides, never deletes); unarchiving
 * is harmless and happens at once. `run` throws on failure; its message is shown in the dialog (or next to the button).
 */
export function ArchiveAction({ archived, noun, consequence, disabled, onArchive, onUnarchive, errorText }: {
  archived: boolean;
  /** "spec" or "intake item". */
  noun: string;
  /** What else gets hidden, shown in the confirmation. */
  consequence?: string;
  disabled?: boolean;
  onArchive: () => Promise<void>;
  onUnarchive: () => Promise<void>;
  errorText: (e: unknown, what: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>, what: string, close: boolean) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (close) setOpen(false);
    } catch (e) {
      setError(errorText(e, what));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {archived ? (
        <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void run(onUnarchive, `unarchive this ${noun}`, false)}>
          Unarchive
        </Button>
      ) : (
        <Button size="sm" variant="outline" icon={Archive} disabled={disabled || busy} onClick={() => { setError(null); setOpen(true); }}>
          Archive
        </Button>
      )}
      {archived && error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="w-[min(28rem,92vw)]">
          <DialogTitle>Archive this {noun}?</DialogTitle>
          <DialogDescription className="mt-2">
            It is hidden from the lists and can be shown again with the Archived filter. Nothing is deleted.
            {consequence ? ` ${consequence}` : ''}
          </DialogDescription>
          {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="button" variant="danger" disabled={busy} onClick={() => void run(onArchive, `archive this ${noun}`, true)}>
              {busy ? 'Archiving…' : 'Archive'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
