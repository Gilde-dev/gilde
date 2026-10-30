'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, SKILLS_LIBRARY_KINDS, type ApiError, type BudgetPeriodStatus, type BudgetStatus, type Project, type ReplaceProjectInput, type SkillsLibraryKind, projectReplacement } from '@/lib/api';
import { periodSummary } from '@/lib/budget';
import { errorText } from '@/lib/job-actions';
import { usePolling, type Polling } from '@/lib/use-polling';
import { withProject } from '@/lib/use-project';
import { CopilotPageContext } from './copilot-provider';
import { McpServersTab } from './mcp-servers-tab';
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

/** A form that PUTs the full project (the latest loaded values with this section's edits on top), shows zod issues through its fields and a short saved state. */
function SettingsForm({
  project,
  build,
  onSaved,
  disabled,
  children,
}: {
  project: Project;
  /** Only this section's fields; every other field comes from `project`, the latest loaded resource. */
  build: () => Partial<ReplaceProjectInput>;
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
      await api.replaceProject(project.id, projectReplacement(project, build()));
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
  const [autoFix, setAutoFix] = useState(project.autoFixConflicts);
  const [autoPlan, setAutoPlan] = useState(project.autoPlan);
  const [autoReview, setAutoReview] = useState(project.autoReview);
  return (
    <SettingsForm
      project={project}
      onSaved={onSaved}
      build={() => ({
        dailyRunLimit: Number(dailyRunLimit),
        maxAttempts: Number(maxAttempts),
        runTimeoutMinutes: Number(timeout),
        retryOnChangesRequested: retry,
        autoFixConflicts: autoFix,
        autoPlan,
        autoReview,
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
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={autoFix} onChange={(e) => setAutoFix(e.target.checked)} />
            <span>
              Fix merge conflicts automatically
              <span className="block text-muted-foreground">
                When an agent PR conflicts with the default branch, send it back once per PR head to merge the branch in. This uses no attempt.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={autoPlan} onChange={(e) => setAutoPlan(e.target.checked)} />
            <span>
              Plan approved specs automatically
              <span className="block text-muted-foreground">
                When a spec version is approved, the Werkmeester drafts a plan. Plans land as draft features with their jobs in triage; nothing is queued
                automatically. Without this you can still use Plan from spec on the spec page.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={autoReview} onChange={(e) => setAutoReview(e.target.checked)} />
            <span>
              Review agent PRs automatically
              <span className="block text-muted-foreground">
                Opt-in, off by default. Setting up the reviewer runtime alone does not enable review; this toggle does. Changes apply to subsequent CI
                observations. Jobs already awaiting review are not retroactively reviewed.
              </span>
            </span>
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

/** Blank = no limit (null). Anything else must be a plain non-negative decimal: never Number('') = 0. */
function parseLimit(raw: string): { value: number | null; message?: string } {
  const t = raw.trim();
  if (t === '') return { value: null };
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t) || !Number.isFinite(Number(t))) return { value: null, message: 'Enter a number of 0 or more, or leave blank for no limit.' };
  return { value: Number(t) };
}

function parseSoftPct(raw: string): { value: number; message?: string } {
  const t = raw.trim();
  const n = Number(t);
  if (t === '' || !Number.isFinite(n) || n <= 0 || n > 100) return { value: 0, message: 'Enter a percentage above 0 and up to 100.' };
  return { value: n };
}

function BudgetForm({
  project,
  budget,
  onSaved,
}: {
  project: Project;
  budget: Polling<BudgetStatus>;
  onSaved: () => void | Promise<void>;
}) {
  const [daily, setDaily] = useState(project.dailyBudgetUsd == null ? '' : String(project.dailyBudgetUsd));
  const [weekly, setWeekly] = useState(project.weeklyBudgetUsd == null ? '' : String(project.weeklyBudgetUsd));
  const [softPct, setSoftPct] = useState(String(project.budgetSoftPct ?? 80));
  const d = parseLimit(daily);
  const w = parseLimit(weekly);
  const s = parseSoftPct(softPct);
  // The first render after a route change still holds another project's status.
  const status = budget.data?.project?.projectId === project.id ? budget.data.project : undefined;
  const spend = (p: BudgetPeriodStatus | undefined) =>
    p ? `Current ${p.period} (UTC): ${periodSummary(p)}.` : budget.error ? 'Current spend could not be loaded.' : 'Current spend is loading…';
  const resetNote = ' Resets at 00:00 UTC';
  return (
    <SettingsForm
      project={project}
      onSaved={async () => {
        await Promise.all([onSaved(), budget.refresh()]);
      }}
      disabled={Boolean(d.message || w.message || s.message)}
      build={() => ({ dailyBudgetUsd: d.value, weeklyBudgetUsd: w.value, budgetSoftPct: s.value })}
    >
      {(error) => (
        <>
          <p className="text-sm text-muted-foreground">
            Estimated USD per UTC day and ISO week (Monday start). Estimated: with a subscription this is notional consumption, not a bill. At the
            hard limit only new automatic dispatch stops; running work and manual use continue, and a manual pause stays separate. Global limits
            are set by the server environment and cannot be edited here.
          </p>
          <Field
            label="Daily budget (estimated USD)"
            path="dailyBudgetUsd"
            error={error}
            message={d.message}
            hint={`Blank = no limit; 0 stops new dispatch immediately.${resetNote} daily. ${spend(status?.day)}`}
          >
            <Input type="text" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
          </Field>
          <Field
            label="Weekly budget (estimated USD)"
            path="weeklyBudgetUsd"
            error={error}
            message={w.message}
            hint={`Blank = no limit; 0 stops new dispatch immediately.${resetNote} on Monday. ${spend(status?.week)}`}
          >
            <Input type="text" inputMode="decimal" value={weekly} onChange={(e) => setWeekly(e.target.value)} />
          </Field>
          <Field
            label="Warn at (% of limit)"
            path="budgetSoftPct"
            error={error}
            message={s.message}
            hint="Above 0 and up to 100. Reaching it raises a warning; reaching the limit stops new dispatch."
          >
            <Input type="text" inputMode="decimal" value={softPct} onChange={(e) => setSoftPct(e.target.value)} />
          </Field>
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
  // The route's project, not the selected one in the dropdown.
  const fetchBudget = useCallback(() => api.getBudget(id), [id]);
  const budget = usePolling(fetchBudget, 30_000);

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
          <TabsTrigger value="budget">Budget</TabsTrigger>
          <TabsTrigger value="skills">Skills library</TabsTrigger>
          <TabsTrigger value="mcp">MCP servers</TabsTrigger>
          <TabsTrigger value="danger">Danger zone</TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="pt-4">
          <GeneralForm project={p} onSaved={project.refresh} />
        </TabsContent>
        <TabsContent value="policies" className="pt-4">
          <PoliciesForm project={p} onSaved={project.refresh} />
        </TabsContent>
        <TabsContent value="budget" className="pt-4">
          <BudgetForm project={p} budget={budget} onSaved={project.refresh} />
        </TabsContent>
        <TabsContent value="skills" className="pt-4">
          <SkillsForm project={p} repos={repos.data ?? []} onSaved={project.refresh} />
        </TabsContent>
        <TabsContent value="mcp" className="pt-4">
          <McpServersTab projectId={p.id} />
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
