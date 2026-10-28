'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { describeReconcile, humanOnlyErrorText } from '@/lib/job-actions';
import { Button } from './ui/button';

/** Runs the reconcile pass for the selected project only and shows what it did. */
export function ReconcileNow({ projectId, onDone }: { projectId: string; onDone?: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  async function run() {
    setBusy(true);
    setNote(null);
    try {
      const result = await api.reconcileProject(projectId);
      setNote({ text: describeReconcile(result), error: false });
      await onDone?.();
    } catch (e) {
      setNote({ text: humanOnlyErrorText(e, 'reconcile a project'), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-4 mt-4 flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void run()}>
        {busy ? 'Reconciling…' : 'Reconcile now'}
      </Button>
      {note && (
        <p role={note.error ? 'alert' : 'status'} className={note.error ? 'text-sm text-danger' : 'text-sm text-muted-foreground'}>
          {note.text}
        </p>
      )}
    </div>
  );
}
