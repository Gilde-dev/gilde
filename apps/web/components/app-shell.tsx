'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type Project, type Repo } from '@/lib/api';
import { useProject, withProject } from '@/lib/use-project';
import { usePolling } from '@/lib/use-polling';
import { cn } from '@/lib/utils';
import { UserMenu } from './user-menu';
import { Badge } from './ui/badge';
import { Select } from './ui/select';

const NAV = [
  { href: '/', label: 'Board' },
  { href: '/features', label: 'Features' },
  { href: '/proposals', label: 'Proposals' },
  { href: '/lessons', label: 'Lessons' },
  { href: '/skills', label: 'Skills' },
  { href: '/metrics', label: 'Metrics' },
];
const SETTINGS = [
  { href: '/settings/projects', label: 'Projects' },
  { href: '/settings/api-keys', label: 'API keys' },
];

const isActive = (pathname: string, href: string) =>
  href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

function NavLinks({
  label,
  links,
  pathname,
  projectId,
  pending,
  onNavigate,
}: {
  label: string;
  links: { href: string; label: string }[];
  pathname: string;
  projectId: string | null;
  pending: number;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label={label} className="flex flex-col gap-0.5 text-sm">
      {links.map((l) => {
        const active = isActive(pathname, l.href);
        return (
          <Link
            key={l.href}
            href={withProject(l.href, projectId)}
            aria-current={active ? 'page' : undefined}
            onClick={onNavigate}
            className={cn(
              'flex items-center justify-between rounded-md px-2 py-1.5',
              active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {l.label}
            {l.href === '/proposals' && pending > 0 && (
              <span aria-label={`${pending} pending`} className="rounded-full bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent">
                {pending}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarContent({
  projects,
  projectId,
  onSelectProject,
  repos,
  pending,
  pathname,
  onNavigate,
}: {
  projects: Project[];
  projectId: string | null;
  onSelectProject: (id: string) => void;
  repos: Repo[] | undefined;
  pending: number;
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-5">
      <Link href={withProject('/', projectId)} onClick={onNavigate} className="font-serif text-xl font-semibold tracking-tight">
        Gilde
      </Link>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Project
          <Select
            className="h-9 text-sm text-foreground"
            value={projectId ?? ''}
            disabled={projects.length === 0}
            onChange={(e) => onSelectProject(e.target.value)}
          >
            {projects.length === 0 && <option value="">No projects</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.paused ? ' (paused)' : ''}
              </option>
            ))}
          </Select>
        </label>
        {repos && repos.length > 0 && (
          <section aria-label="Repos">
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Repos</h2>
            <ul className="space-y-1">
              {repos.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 text-xs">
                  <a
                    href={`https://github.com/${r.fullName}`}
                    target="_blank"
                    rel="noreferrer"
                    title={r.fullName}
                    className="truncate font-mono text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {r.fullName}
                  </a>
                  {r.paused && <Badge variant="warning">paused</Badge>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <NavLinks label="Main" links={NAV} pathname={pathname} projectId={projectId} pending={pending} onNavigate={onNavigate} />
      <div>
        <h2 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Settings</h2>
        <NavLinks label="Settings" links={SETTINGS} pathname={pathname} projectId={projectId} pending={0} onNavigate={onNavigate} />
      </div>
      <div className="mt-auto">
        <UserMenu />
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { projects, projectId, setProjectId } = useProject();
  const [drawer, setDrawer] = useState(false);

  const fetchRepos = useCallback(() => (projectId ? api.listRepos(projectId) : Promise.resolve([] as Repo[])), [projectId]);
  const repos = usePolling(fetchRepos, 30_000);
  const fetchProposed = useCallback(() => api.listRevisions('proposed', projectId ?? undefined), [projectId]);
  const proposed = usePolling(fetchProposed, 30_000);

  useEffect(() => setDrawer(false), [pathname]);

  const sidebar = (onNavigate?: () => void) => (
    <SidebarContent
      projects={projects ?? []}
      projectId={projectId}
      onSelectProject={setProjectId}
      repos={repos.data}
      pending={proposed.data?.length ?? 0}
      pathname={pathname}
      onNavigate={onNavigate}
    />
  );

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="hidden w-60 shrink-0 border-r border-border bg-muted/40 p-4 md:block">{sidebar()}</aside>
      <DialogPrimitive.Root open={drawer} onOpenChange={setDrawer}>
        <header className="flex items-center gap-3 border-b border-border bg-muted/40 px-4 py-2 md:hidden">
          <DialogPrimitive.Trigger
            aria-label="Open menu"
            className="rounded-md border border-input px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            ☰ Menu
          </DialogPrimitive.Trigger>
          <span className="font-serif text-lg font-semibold">Gilde</span>
        </header>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/50 md:hidden" />
          <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] overflow-y-auto border-r border-border bg-popover p-4 text-foreground shadow-lg md:hidden">
            <DialogPrimitive.Title className="sr-only">Menu</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">Navigation and project switcher</DialogPrimitive.Description>
            {sidebar(() => setDrawer(false))}
            <DialogPrimitive.Close
              aria-label="Close menu"
              className="absolute right-3 top-3 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              ✕
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <main className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-7xl">{children}</div>
      </main>
    </div>
  );
}
