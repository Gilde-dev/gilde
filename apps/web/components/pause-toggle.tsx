'use client';

import { useState } from 'react';
import { errorText } from '@/lib/job-actions';
import { Button } from './ui/button';

/** Pause/Resume button for a repo or project. `toggle(paused)` is the api call; onChanged refreshes data. */
export function PauseToggle({
  paused,
  label,
  toggle,
  onChanged,
}: {
  paused: boolean;
  label: string;
  toggle: (paused: boolean) => Promise<unknown>;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        aria-label={`${paused ? 'Resume' : 'Pause'} ${label}`}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await toggle(!paused);
            await onChanged();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {paused ? 'Resume' : 'Pause'}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-red-800">
          {error}
        </span>
      )}
    </span>
  );
}
