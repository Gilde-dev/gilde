'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, SKILLS_LIBRARY_KINDS, type ApiError, type Project, type SkillsLibraryKind, type UpdateProjectInput } from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { usePolling } from '@/lib/use-polling';
import { withProject } from '@/lib/use-project';
import { CopilotPageContext } from './copilot-provider';
import { PauseToggle } from './pause-toggle';
import { ReposSection } from './repos-section';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';
import { Field } from './ui/field';
import { Input } from './ui/input';
import { PageHeader } from './ui/page-header';
import { Select } from './ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Textarea } from './ui/textarea';

const LIBRARY_LABEL: Record<SkillsLibraryKind, string> = {
  none: 'None',
  folder: 'Folder on the API server',
  repo: 'Repo of this project',
};

/** A form that PATCHes the project, shows zod issues through its fields and a short saved state. */
function SettingsForm({
  project,
  build,
  onSaved,
  disabled,
  children,
}: {
  project: Project;
  build: () => UpdateProjectInput;
  onSaved: () => void | Promise<void>;
  disabled?: boolean;
  children: (error: unknown) => ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(t);
  }, [saved]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateProject(project.id, build());
      await onSaved();
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="max-w-xl space-y-3">
      {children(error)}
      {error != null && (error as ApiError).issues?.length === 0 && (
        <p role="alert" className="text-sm text-danger">
          {errorText(error)}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || disabled}>
          Save
        </Button>
        {saved && (
          <span role="status" className="text-sm text-success">
            Saved
          </span>
        )}
      </div>
    </form>
  );
}

function GeneralForm({ project, onSaved }: { project: Project; onSaved: () => void | Promise<void> }) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  return (
    <SettingsForm project={project} onSaved={onSaved} build={() => ({ name: name.trim(), description: description.trim() || null })}>
      {(error) => (
        <>
          <Field label="Name" path="name" error={error}>
            <Input value={name} maxLength={100} required onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Slug" hint="The slug can't be changed.">
            <Input value={project.slug} readOnly className="font-mono" />
          </Field>
          <Field label="Description" path="description" error={error}>
            <Textarea value={description} rows={4} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </>
      )}
    </SettingsForm>
  );
}

function PoliciesForm({ project, onSaved }: { project: Project; onSaved: () => void | Promise<void> }) {
  const [dailyRunLimit, setDailyRunLimit] = useState(String(project.dailyRunLimit));
  const [maxAttempts, setMaxAttempts] = useState(String(project.maxAttempts));
  const [timeout, setTimeoutMinutes] = useState(String(project.runTimeoutMinutes));
  const [retry, setRetry] = useState(project.retryOnChangesRequested);
  return (
    <SettingsForm
      project={project}
      onSaved={onSaved}
      build={() => ({
        dailyRunLimit: Number(dailyRunLimit),
        maxAttempts: Number(maxAttempts),
        runTimeoutMinutes: Number(timeout),
        retryOnChangesRequested: retry,
      })}
    >
      {(error) => (
        <>
          <Field label="Daily run limit" path="dailyRunLimit" error={error} hint="Runs fired per day across the project.">
            <Input type="number" value={dailyRunLimit} onChange={(e) => setDailyRunLimit(e.target.value)} />
          </Field>
          <Field label="Max attempts" path="maxAttempts" error={error} hint="Attempts per job before it is parked.">
            <Input type="number" value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} />
          </Field>
          <Field label="Run timeout (minutes)" path="runTimeoutMinutes" error={error}>
            <Input type="number" value={timeout} onChange={(e) => setTimeoutMinutes(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={retry} onChange={(e) => setRetry(e.target.checked)} />
            Retry when changes are requested
          </label>
        </>
      )}
    </SettingsForm>
  );
}

function SkillsForm({
  project,
  repos,
  onSaved,
}: {
  project: Project;
  repos: { id: string; fullName: string }[];
  onSaved: () => void | Promise<void>;
}) {
  const [kind, setKind] = useState<SkillsLibraryKind>(project.skillsLibrary);
  const [repoId, setRepoId] = useState(project.skillsLibraryRepoId ?? '');
  return (
    <SettingsForm
      project={project}
      onSaved={onSaved}
      disabled={kind === 'repo' && !repoId}
      build={() => ({ skillsLibrary: kind, skillsLibraryRepoId: kind === 'repo' ? repoId : null })}
    >
      {(error) => (
        <>
          <Field label="Skills library" path="skillsLibrary" error={error} hint="Where the gildeboek skills for this project come from.">
            <Select value={kind} onChange={(e) => setKind(e.target.value as SkillsLibraryKind)}>
              {SKILLS_LIBRARY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {LIBRARY_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          {kind === 'repo' && (
            <Field label="Library repo" path="skillsLibraryRepoId" error={error}>
              <Select value={repoId} onChange={(e) => setRepoId(e.target.value)}>
                <option value="">Choose a repo…</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </>
      )}
    </SettingsForm>
  );
}

export function ProjectSettingsView() {
  const { id } = useParams<{ id: string }>();
  const fetchProject = useCallback(() => api.getProject(id), [id]);
  const project = usePolling(fetchProject, 30_000);
  const fetchRepos = useCallback(() => api.listRepos(id), [id]);
  const repos = usePolling(fetchRepos, 30_000);

  const back = (
    <Link href={withProject('/settings/projects', id)} className="text-sm text-muted-foreground hover:text-foreground hover:underline">
      ← All projects
    </Link>
  );

  if (project.error && !project.data) {
    return (
      <div className="space-y-3 p-4">
        {back}
        <EmptyState title="Project not found" text="It does not exist or you cannot access it." />
      </div>
    );
  }
  const p = project.data;
  if (!p) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6 p-4">
      {back}
      <PageHeader
        title={
          <>
            {p.name} {p.paused && <Badge variant="warning">paused</Badge>}
          </>
        }
        description={<span className="font-mono">{p.slug}</span>}
      />
      <Tabs defaultValue="general">
        <TabsList aria-label="Project settings">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
          <TabsTrigger value="skills">Skills library</TabsTrigger>
          <TabsTrigger value="danger">Danger zone</TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="pt-4">
          <GeneralForm project={p} onSaved={project.refresh} />
        </TabsContent>
        <TabsContent value="policies" className="pt-4">
          <PoliciesForm project={p} onSaved={project.refresh} />
        </TabsContent>
        <TabsContent value="skills" className="pt-4">
          <SkillsForm project={p} repos={repos.data ?? []} onSaved={project.refresh} />
        </TabsContent>
        <TabsContent value="danger" className="pt-4">
          <div className="max-w-xl space-y-2 rounded-lg border border-danger/40 p-4">
            <h2 className="font-serif text-base font-semibold">{p.paused ? 'Resume project' : 'Pause project'}</h2>
            <p className="text-sm text-muted-foreground">
              {p.paused
                ? 'Dispatching is stopped for every repo in this project. Resume to fire queued jobs again.'
                : 'Stops dispatching new runs for every repo in this project. Runs in flight are not interrupted.'}
            </p>
            <PauseToggle
              paused={p.paused}
              label={`project ${p.name}`}
              toggle={(paused) => api.setProjectPaused(p.id, paused)}
              onChanged={project.refresh}
            />
          </div>
        </TabsContent>
      </Tabs>
      <ReposSection projectId={p.id} />
      <CopilotPageContext description="The project settings page in the Gilde UI" value={{ projectId: p.id }} />
    </div>
  );
}
