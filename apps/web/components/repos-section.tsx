'use client';

import { useCallback, useState } from 'react';
import { api, type Repo } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { PauseToggle } from './pause-toggle';
import { RepoDialog } from './repo-dialog';
import { RepoManifest } from './repo-manifest';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';

function WorkspaceStatus({ repoId }: { repoId: string }) {
  const fetchWorkspace = useCallback(() => api.getRepoWorkspace(repoId), [repoId]);
  const ws = usePolling(fetchWorkspace, 30_000);
  if (ws.error) return <p className="text-xs text-danger">{ws.error.message}</p>;
  if (!ws.data) return <p className="text-xs text-muted-foreground">Workspace…</p>;
  const w = ws.data;
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      <p>
        Workspace: {w.cloned ? 'cloned' : 'not cloned'}
        {w.headSha && (
          <>
            {' '}
            at <code className="font-mono">{w.headSha.slice(0, 7)}</code>
          </>
        )}
      </p>
      <p>{w.fetchedAt ? `Last sync ${new Date(w.fetchedAt).toLocaleString()}` : 'Never synced'}</p>
      {w.error && (
        <p role="alert" className="text-danger">
          {w.error}
        </p>
      )}
    </div>
  );
}

/** The repos of a project: table with add/edit, pause, manifest refresh and workspace status. */
export function ReposSection({ projectId }: { projectId: string }) {
  const fetchRepos = useCallback(() => api.listRepos(projectId), [projectId]);
  const repos = usePolling(fetchRepos, 15_000);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Repo | null>(null);

  return (
    <section aria-label="Repos" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-serif text-lg font-semibold">Repos</h2>
        <Button size="sm" onClick={() => setAdding(true)}>
          Add repo
        </Button>
      </div>
      {repos.error && <p className="text-sm text-danger">{repos.error.message}</p>}
      {repos.data?.length === 0 && <EmptyState title="No repos yet" text="Add a GitHub repo to queue jobs against it." />}
      {repos.data && repos.data.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Repo</th>
                <th className="px-3 py-2">Branch</th>
                <th className="px-3 py-2">Concurrency</th>
                <th className="px-3 py-2">Routine</th>
                <th className="px-3 py-2">Manifest and workspace</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {repos.data.map((r) => (
                <tr key={r.id} id={`repo-${r.id}`} className="scroll-mt-4 border-t border-border align-top">
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs">{r.fullName}</span>
                    {r.paused && (
                      <Badge variant="warning" className="ml-2">
                        paused
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.defaultBranch}</td>
                  <td className="px-3 py-2">{r.maxConcurrentJobs}</td>
                  <td className="px-3 py-2">{r.routineFireUrl && r.routineTokenEnv ? 'yes' : 'no'}</td>
                  <td className="space-y-2 px-3 py-2">
                    <RepoManifest repo={r} onChanged={repos.refresh} />
                    <WorkspaceStatus repoId={r.id} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col items-start gap-2">
                      <Button size="sm" variant="outline" aria-label={`Edit ${r.fullName}`} onClick={() => setEditing(r)}>
                        Edit
                      </Button>
                      <PauseToggle
                        paused={r.paused}
                        label={r.fullName}
                        toggle={(paused) => api.setRepoPaused(r.id, paused)}
                        onChanged={repos.refresh}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RepoDialog open={adding} projectId={projectId} onClose={() => setAdding(false)} onSaved={repos.refresh} />
      <RepoDialog
        open={editing !== null}
        projectId={projectId}
        repo={editing ?? undefined}
        onClose={() => setEditing(null)}
        onSaved={repos.refresh}
      />
    </section>
  );
}
