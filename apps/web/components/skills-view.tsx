'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  SKILLS_LIBRARY_KINDS,
  api,
  projectReplacement,
  type Project,
  type Repo,
  type RepoSkills,
  type SkillStatus,
  type SkillsLibraryKind,
} from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { usePolling } from '@/lib/use-polling';
import { useProject } from '@/lib/use-project';
import { PromoteSkillDialog } from './promote-skill-dialog';
import { NoProjects } from './no-projects';
import { Badge, type BadgeVariant } from './ui/badge';
import { SkillImpactView } from './skill-impact-view';
import { Button } from './ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

const POLL_MS = 60_000;
const SELECT = 'h-9 rounded-md border border-input bg-card px-2 text-sm';

const LIBRARY_LABELS: Record<SkillsLibraryKind, string> = { none: 'None', folder: 'Server folder', repo: 'Repo' };

export const STATUS_VARIANTS: Record<SkillStatus, BadgeVariant> = {
  ok: 'success',
  outdated: 'warning',
  missing: 'warning',
  orphaned: 'warning',
  conflict: 'danger',
  repo: 'neutral',
};

export function SkillsView() {
  const { projects, project, projectId, refresh: refreshProjects } = useProject();
  const tab = useSearchParams().get('tab');

  const fetchRepos = useCallback(() => (projectId ? api.listRepos(projectId) : Promise.resolve([] as Repo[])), [projectId]);
  const repos = usePolling(fetchRepos, POLL_MS);

  // Depend on the library config, not the project object: it is a new object on every poll.
  const library = project ? `${project.skillsLibrary}:${project.skillsLibraryRepoId ?? ''}` : '';
  const fetchCatalog = useCallback(
    () => (projectId && library && !library.startsWith('none:') ? api.getSkillCatalog(projectId) : Promise.resolve(null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, library],
  );
  const catalog = usePolling(fetchCatalog, POLL_MS);

  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  async function refresh() {
    if (!projectId) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await api.refreshSkillCatalog(projectId);
    } catch (e) {
      setRefreshError(errorText(e));
    } finally {
      await catalog.refresh();
      setRefreshing(false);
    }
  }

  return (
    <>
        <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <h2 className="font-serif text-lg font-semibold">Skills</h2>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {project && project.skillsLibrary !== 'none' && (
              <Button size="sm" onClick={refresh} disabled={refreshing}>
                Refresh
              </Button>
            )}
          </div>
        </header>
        {projects?.length === 0 && <NoProjects />}
        {project && <LibrarySettings project={project} repos={repos.data ?? []} onSaved={refreshProjects} />}
        {refreshError && <p role="alert" className="px-4 pt-3 text-sm text-danger">{refreshError}</p>}
        {project && project.skillsLibrary === 'none' && (
          <p className="p-4 text-sm text-muted-foreground">No skills library is configured for this project.</p>
        )}
        <Tabs defaultValue={tab === 'impact' ? 'impact' : 'library'} className="px-4 pt-3">
          <TabsList>
            <TabsTrigger value="library">Library</TabsTrigger>
            <TabsTrigger value="impact">Impact</TabsTrigger>
          </TabsList>
          <TabsContent value="impact" className="-mx-4">
            {projectId && <SkillImpactView projectId={projectId} />}
          </TabsContent>
          <TabsContent value="library" className="-mx-4">
        {catalog.error && <p role="alert" className="px-4 pt-3 text-sm text-danger">{catalog.error.message}</p>}
        {catalog.data && (
          <>
            <section className="p-4">
              <h3 className="mb-2 text-sm font-semibold">
                Library ({catalog.data.library.kind === 'repo' ? catalog.data.library.repoFullName : 'server folder'})
              </h3>
              <ul className="space-y-2">
                {catalog.data.skills.map((s) => (
                  <li key={s.name} aria-label={`Library skill ${s.name}`} className="rounded-md border border-border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{s.name}</span>
                      <Badge variant="neutral">{s.scope === 'global' ? 'global' : `stacks: ${s.stacks.join(', ')}`}</Badge>
                    </div>
                    <p className="text-muted-foreground">{s.description}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Repos: {s.repos.length > 0 ? s.repos.map((r) => r.fullName).join(', ') : 'none'}
                    </p>
                  </li>
                ))}
                {catalog.data.skills.length === 0 && <li className="text-sm text-muted-foreground">The library has no skills.</li>}
              </ul>
            </section>
            <section className="p-4 pt-0">
              <h3 className="mb-1 text-sm font-semibold">Repos</h3>
              <p className="mb-2 text-xs text-muted-foreground">
                The repo sync workflow fixes outdated, missing and orphaned skills. Conflicts need a human: rename or remove the repo skill.
              </p>
              <ul className="space-y-3">
                {repos.data?.map((r) => (
                  <RepoSkillsCard key={r.id} repo={r} canPromote={project?.skillsLibrary !== 'none'} onPromoted={catalog.refresh} />
                ))}
              </ul>
            </section>
          </>
        )}
          </TabsContent>
        </Tabs>
    </>
  );
}

function LibrarySettings({ project, repos, onSaved }: { project: Project; repos: Repo[]; onSaved: () => void | Promise<void> }) {
  const [kind, setKind] = useState<SkillsLibraryKind>(project.skillsLibrary);
  const [repoId, setRepoId] = useState(project.skillsLibraryRepoId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setKind(project.skillsLibrary);
    setRepoId(project.skillsLibraryRepoId ?? '');
  }, [project.id, project.skillsLibrary, project.skillsLibraryRepoId]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.replaceProject(project.id, projectReplacement(project, { skillsLibrary: kind, skillsLibraryRepoId: kind === 'repo' ? repoId : null }));
      await onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 text-sm">
      <label className="flex items-center gap-2">
        Skills library
        <select className={SELECT} value={kind} onChange={(e) => setKind(e.target.value as SkillsLibraryKind)}>
          {SKILLS_LIBRARY_KINDS.map((k) => (
            <option key={k} value={k}>
              {LIBRARY_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      {kind === 'repo' && (
        <select aria-label="Library repo" className={SELECT} value={repoId} onChange={(e) => setRepoId(e.target.value)}>
          <option value="">Select a repo…</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.fullName}
            </option>
          ))}
        </select>
      )}
      <Button size="sm" variant="outline" onClick={save} disabled={busy || (kind === 'repo' && !repoId)}>
        Save
      </Button>
      {error && <p role="alert" className="w-full text-danger">{error}</p>}
    </div>
  );
}

function RepoSkillsCard({ repo, canPromote, onPromoted }: { repo: Repo; canPromote: boolean; onPromoted: () => void | Promise<void> }) {
  const [promoting, setPromoting] = useState<string | null>(null);
  const fetchSkills = useCallback(() => api.getRepoSkills(repo.id), [repo.id]);
  const skills = usePolling<RepoSkills>(fetchSkills, POLL_MS);
  return (
    <li aria-label={`Repo ${repo.fullName}`} className="rounded-md border border-border p-3 text-sm">
      <div className="mb-2 font-medium">{repo.fullName}</div>
      {skills.error && <p role="alert" className="text-danger">{skills.error.message}</p>}
      {skills.data && (
        <>
          <p className="mb-2 text-xs text-muted-foreground">
            {Object.entries(skills.data.counts)
              .filter(([, n]) => n > 0)
              .map(([status, n]) => `${n} ${status}`)
              .join(' · ') || 'No skills'}
          </p>
          <ul className="space-y-1">
            {skills.data.skills.map((s) => (
              <li key={s.name} className="flex flex-wrap items-center gap-2">
                <span>{s.name}</span>
                <Badge variant={STATUS_VARIANTS[s.status]}>{s.status}</Badge>
                {s.managedBy && <span className="text-xs text-muted-foreground">{s.managedBy}</span>}
                {canPromote && s.source === 'repo' && s.status === 'repo' && (
                  <Button size="sm" variant="outline" aria-label={`Promote ${s.name}`} onClick={() => setPromoting(s.name)}>
                    Promote
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {promoting && (
        <PromoteSkillDialog
          repo={repo}
          skillName={promoting}
          onClose={() => setPromoting(null)}
          onPromoted={async () => {
            await onPromoted();
            await skills.refresh();
          }}
        />
      )}
    </li>
  );
}
