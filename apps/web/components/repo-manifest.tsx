'use client';

import { useState } from 'react';
import { api, type Repo } from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { Button } from './ui/button';

const MANIFEST_STATUS_TEXT: Record<NonNullable<Repo['manifestStatus']>, string> = {
  ok: 'The manifest was read and is valid.',
  missing: 'Jobs run in bootstrap mode until the first job adds `.gilde.json`.',
  invalid: '`.gilde.json` is not valid JSON or does not match the schema. Jobs are held until it is fixed.',
  unreachable: 'Gilde could not read the repo (app not installed, no access or a network problem). Jobs are held until it can.',
};

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
      {repo.manifestStatus && (
        <p data-testid="manifest-status">
          <span className="font-medium text-foreground">Manifest: {repo.manifestStatus}</span>. {MANIFEST_STATUS_TEXT[repo.manifestStatus]}
        </p>
      )}
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
