'use client';

import { api, type Project, type Repo } from '@/lib/api';
import { PauseToggle } from './pause-toggle';
import { SidebarNav } from './sidebar-nav';
import { Badge } from './ui/badge';

export function Sidebar({
  projects,
  projectId,
  repos,
  reposError,
  onSelectProject,
  onChanged,
}: {
  projects: Project[];
  projectId: string | null;
  repos: Repo[] | undefined;
  reposError?: Error | null;
  onSelectProject: (id: string) => void;
  onChanged?: () => void | Promise<void>;
}) {
  return (
    <aside className="flex w-60 shrink-0 flex-col gap-4 border-r border-border bg-muted/40 p-4">
      <h1 className="text-lg font-bold">Gilde</h1>
      <SidebarNav current="/" />
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Project
        <select
          className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          value={projectId ?? ''}
          onChange={(e) => onSelectProject(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.paused ? ' (paused)' : ''}
            </option>
          ))}
        </select>
      </label>
      <div>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Repos</h2>
        {reposError && <p className="text-xs text-red-800">{reposError.message}</p>}
        <ul className="space-y-2">
          {repos?.map((r) => (
            <li key={r.id} className="text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate" title={r.fullName}>
                  {r.fullName}
                </span>
                {r.paused && <Badge variant="warning">paused</Badge>}
              </div>
              {r.paused && r.pausedReason && <p className="text-xs text-muted-foreground">{r.pausedReason}</p>}
              <div className="mt-1">
                <PauseToggle
                  paused={r.paused}
                  label={r.fullName}
                  toggle={(paused) => api.setRepoPaused(r.id, paused)}
                  onChanged={onChanged ?? (() => {})}
                />
              </div>
            </li>
          ))}
          {repos?.length === 0 && <li className="text-xs text-muted-foreground">No repos</li>}
        </ul>
      </div>
    </aside>
  );
}
