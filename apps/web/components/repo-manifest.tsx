'use client';

import { useState } from 'react';
import { api, type Repo } from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { Button } from './ui/button';

/** A repo's cached .gilde.json: stacks, test commands, last sync and any sync error, with a Refresh button. */
export function RepoManifest({ repo, onChanged }: { repo: Repo; onChanged: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-1 space-y-1 text-xs text-muted-foreground">
      {repo.stacks.length > 0 && <p>Stacks: {repo.stacks.join(', ')}</p>}
      {repo.testCommands.length > 0 && (
        <div>
          Test commands:
          <ul>
            {repo.testCommands.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p>{repo.manifestSyncedAt ? `Manifest synced ${new Date(repo.manifestSyncedAt).toLocaleString()}` : 'Manifest not synced yet'}</p>
      {repo.manifestError && (
        <p role="alert" className="text-danger">
          {repo.manifestError}
        </p>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        aria-label={`Refresh manifest ${repo.fullName}`}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api.refreshRepoManifest(repo.id);
            await onChanged();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Refresh
      </Button>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
