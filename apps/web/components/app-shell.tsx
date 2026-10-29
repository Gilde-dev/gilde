'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Bot,
  BookOpen,
  ChartColumn,
  FileText,
  FolderKanban,
  Inbox,
  KeyRound,
  Server,
  Layers,
  LayoutDashboard,
  MessageSquare,
  Lightbulb,
  Menu,
  ChevronRight as ChevronRightGlyph,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type IntakeItem, type Job, type Project, type Repo } from '@/lib/api';
import { activeJobCount } from '@/lib/job-stats';
import { useProject, withProject } from '@/lib/use-project';
import { usePolling } from '@/lib/use-polling';
import { cn } from '@/lib/utils';
import { GildeLogoTile } from './gilde-mark';
import { UserMenu } from './user-menu';
import { Avatar } from './ui/avatar';
import { Badge } from './ui/badge';
import { Icon } from './ui/icon';
import { Select } from './ui/select';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}
const NAV: NavItem[] = [
  { href: '/', label: 'Board', icon: LayoutDashboard },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/features', label: 'Features', icon: Layers },
  { href: '/specs', label: 'Specs', icon: FileText },
  { href: '/intake', label: 'Intake', icon: Inbox },
  { href: '/proposals', label: 'Proposals', icon: Lightbulb },
  { href: '/lessons', label: 'Lessons', icon: BookOpen },
  { href: '/skills', label: 'Skills', icon: Sparkles },
  { href: '/metrics', label: 'Metrics', icon: ChartColumn },
  { href: '/agents', label: 'Agents', icon: Bot },
];
const SETTINGS: NavItem[] = [
  { href: '/settings/projects', label: 'Projects', icon: FolderKanban },
  { href: '/settings/api-keys', label: 'API keys', icon: KeyRound },
  { href: '/settings/executors', label: 'Executors', icon: Server },
];

/** localStorage key of the desktop icon-rail preference ('1' = rail). */
export const SIDEBAR_STORAGE_KEY = 'gilde_sidebar_collapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
function writeCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // storage unavailable: the choice only lasts for this page view
  }
}

const isActive = (pathname: string, href: string) =>
  href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

function NavLinks({
  label,
  links,
  pathname,
  projectId,
  badges,
  compact,
  onNavigate,
}: {
  label: string;
  links: NavItem[];
  pathname: string;
  projectId: string | null;
  badges: Record<string, { count: number; label: string; title?: string; variant: 'accent' | 'running' | 'danger' }>;
  compact: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label={label} className="flex flex-col gap-0.5 text-md">
      {links.map((l) => {
        const active = isActive(pathname, l.href);
        const badge = badges[l.href];
        return (
          <Link
            key={l.href}
            href={withProject(l.href, projectId)}
            aria-current={active ? 'page' : undefined}
            title={compact ? l.label : undefined}
            onClick={onNavigate}
            className={cn(
              'relative flex h-9 items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              compact ? 'justify-center px-0' : 'px-2',
              active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon icon={l.icon} />
            <span className={cn(compact ? 'sr-only' : 'flex-1 truncate')}>{l.label}</span>
            {badge && badge.count > 0 && (
              <Badge
                variant={badge.variant}
                aria-label={badge.label}
                title={badge.title}
                className={cn('px-1.5 py-0', compact && 'absolute right-0 top-0 min-w-4 justify-center px-1 text-[10px] leading-4')}
              >
                {badge.count}
              </Badge>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function ProjectSwitcher({
  projects,
  projectId,
  onSelectProject,
  compact,
}: {
  projects: Project[];
  projectId: string | null;
  onSelectProject: (id: string) => void;
  compact: boolean;
}) {
  const current = projects.find((p) => p.id === projectId);
  const select = (
    <Select
      aria-label="Project"
      className={cn('h-9 text-sm text-foreground', compact && 'absolute inset-0 size-full cursor-pointer opacity-0')}
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
  );
  if (compact) {
    return (
      <span
        title={current ? `Project: ${current.name}` : 'Project'}
        className="relative mx-auto flex size-10 rounded-md focus-within:ring-2 focus-within:ring-ring"
      >
        <Avatar name={current?.name} size={32} className="m-auto rounded-md" />
        {select}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-label text-muted-foreground">
      <span aria-hidden="true">Project</span>
      {select}
    </div>
  );
}

function SidebarContent({
  projects,
  projectId,
  onSelectProject,
  repos,
  pending,
  active,
  failedIntake,
  pathname,
  compact = false,
  onNavigate,
}: {
  projects: Project[];
  projectId: string | null;
  onSelectProject: (id: string) => void;
  repos: Repo[] | undefined;
  pending: number;
  active: number | undefined;
  failedIntake: number;
  pathname: string;
  compact?: boolean;
  onNavigate?: () => void;
}) {
  const badges = {
    '/proposals': { count: pending, label: `${pending} pending`, variant: 'accent' as const },
    '/intake': { count: failedIntake, label: `${failedIntake} failed`, title: 'Intake items whose refining failed', variant: 'danger' as const },
    '/': {
      count: active ?? 0,
      label: `${active ?? 0} active`,
      title: 'Queued, running, PR open or awaiting review, among the jobs loaded for this project (up to 200)',
      variant: 'running' as const,
    },
  };
  return (
    <div className="flex h-full flex-col gap-5">
      <Link
        href={withProject('/', projectId)}
        onClick={onNavigate}
        aria-label="Gilde"
        className={cn('flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', compact && 'justify-center')}
      >
        <GildeLogoTile size={32} />
        {!compact && <span className="text-lg font-semibold tracking-tight">Gilde</span>}
      </Link>
      <ProjectSwitcher projects={projects} projectId={projectId} onSelectProject={onSelectProject} compact={compact} />
      <NavLinks label="Main" links={NAV} pathname={pathname} projectId={projectId} badges={badges} compact={compact} onNavigate={onNavigate} />
      {!compact && repos && repos.length > 0 && (
        <section aria-label="Repos">
          <h2 className="mb-1 px-2 text-label uppercase tracking-wide text-muted-foreground">Repos</h2>
          <ul className="space-y-1 px-2">
            {repos.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                <Link
                  href={`${withProject(`/settings/projects/${projectId}`, projectId)}#repo-${r.id}`}
                  onClick={onNavigate}
                  title={r.fullName}
                  className="truncate font-mono text-muted-foreground hover:text-foreground hover:underline"
                >
                  {r.fullName}
                </Link>
                {r.paused && <Badge variant="warning">paused</Badge>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div>
        {!compact && <h2 className="mb-1 px-2 text-label uppercase tracking-wide text-muted-foreground">Settings</h2>}
        <NavLinks label="Settings" links={SETTINGS} pathname={pathname} projectId={projectId} badges={{}} compact={compact} onNavigate={onNavigate} />
      </div>
      <div className="mt-auto">
        <UserMenu compact={compact} />
      </div>
    </div>
  );
}

function Breadcrumb({ project, pathname, projectId }: { project: Project | undefined; pathname: string; projectId: string | null }) {
  const section = [...NAV, ...SETTINGS].find((l) => isActive(pathname, l.href));
  const items: { label: string; href?: string }[] = [];
  if (project) items.push({ label: project.name, href: withProject('/', projectId) });
  if (section) items.push({ label: section.label });
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1 text-sm text-muted-foreground">
        {items.map((item, i) => (
          <li key={item.label} className="flex min-w-0 items-center gap-1">
            {i > 0 && <Icon icon={ChevronRightGlyph} size={14} />}
            {i === items.length - 1 ? (
              <span aria-current="page" className="truncate font-medium text-foreground">
                {item.label}
              </span>
            ) : (
              <Link href={item.href ?? '/'} className="truncate hover:text-foreground hover:underline">
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { projects, project, projectId, setProjectId } = useProject();
  const [drawer, setDrawer] = useState(false);
  // The desktop rail preference. Read after mount so the server render and first client render match.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setCollapsed(readCollapsed()), []);
  const toggleRail = () => {
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });
  };

  const fetchRepos = useCallback(() => (projectId ? api.listRepos(projectId) : Promise.resolve([] as Repo[])), [projectId]);
  const repos = usePolling(fetchRepos, 30_000);
  const fetchProposed = useCallback(() => api.listRevisions('proposed', projectId ?? undefined), [projectId]);
  const proposed = usePolling(fetchProposed, 30_000);
  // The board badge counts the same loaded list the board shows (up to 200 jobs), not the project's history.
  const fetchJobs = useCallback(() => (projectId ? api.listJobs(projectId) : Promise.resolve([] as Job[])), [projectId]);
  const jobs = usePolling(fetchJobs, 30_000);
  const fetchFailedIntake = useCallback(
    () => (projectId ? api.listIntake(projectId, 'failed') : Promise.resolve([] as IntakeItem[])),
    [projectId],
  );
  const failedIntake = usePolling(fetchFailedIntake, 30_000);
  const active = jobs.data && projectId ? activeJobCount(jobs.data.filter((j) => j.projectId === projectId)) : undefined;

  useEffect(() => setDrawer(false), [pathname]);

  const sidebar = (opts: { compact?: boolean; onNavigate?: () => void }) => (
    <SidebarContent
      projects={projects ?? []}
      projectId={projectId}
      onSelectProject={setProjectId}
      repos={repos.data}
      pending={proposed.data?.length ?? 0}
      active={active}
      failedIntake={failedIntake.data?.length ?? 0}
      pathname={pathname}
      {...opts}
    />
  );

  return (
    <DialogPrimitive.Root open={drawer} onOpenChange={setDrawer}>
      <div className="flex min-h-screen bg-background">
        <aside
          data-collapsed={collapsed}
          className={cn('sticky top-0 hidden h-screen shrink-0 overflow-y-auto bg-sidebar p-4 md:block', collapsed ? 'w-16 px-3' : 'w-60')}
        >
          {sidebar({ compact: collapsed })}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col p-3">
          <main className="flex min-h-[calc(100vh-24px)] min-w-0 flex-1 flex-col rounded-xl border border-border bg-surface shadow-sm">
            <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2">
              <DialogPrimitive.Trigger
                aria-label="Open menu"
                className="inline-flex size-8 items-center justify-center rounded-md border border-input text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
              >
                <Icon icon={Menu} />
              </DialogPrimitive.Trigger>
              <button
                type="button"
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-pressed={collapsed}
                title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                onClick={toggleRail}
                className="hidden size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
              >
                <Icon icon={collapsed ? PanelLeftOpen : PanelLeftClose} />
              </button>
              <Breadcrumb project={project} pathname={pathname} projectId={projectId} />
            </div>
            <div className="mx-auto w-full max-w-7xl min-w-0 flex-1">{children}</div>
          </main>
        </div>
      </div>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/50 md:hidden" />
        <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] overflow-y-auto border-r border-border bg-sidebar p-4 text-foreground shadow-lg md:hidden">
          <DialogPrimitive.Title className="sr-only">Menu</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Navigation and project switcher</DialogPrimitive.Description>
          {sidebar({ onNavigate: () => setDrawer(false) })}
          <DialogPrimitive.Close
            aria-label="Close menu"
            className="absolute right-3 top-3 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon icon={X} />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
