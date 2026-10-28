'use client';

import { Plus, Server } from 'lucide-react';
import { useCallback, useState, type FormEvent } from 'react';
import { api, ApiError, executorReplacement, type Executor, type Repo } from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { useProject } from '@/lib/use-project';
import { usePolling } from '@/lib/use-polling';
import { NoProjects } from './no-projects';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { EmptyState } from './ui/empty-state';
import { Field, issueMessages } from './ui/field';
import { Input } from './ui/input';
import { PageHeader } from './ui/page-header';
import { Skeleton } from './ui/skeleton';

const formatDate = (iso: string) => new Date(iso).toLocaleString();
const isNotConfigured = (e: unknown) => e instanceof ApiError && e.status === 503;
const maskedToken = (e: Executor) => (e.hasToken && e.tokenLast4 ? `••••${e.tokenLast4}` : 'no token');
const isActiveExhaustion = (e: Executor) => e.exhaustedUntil != null && new Date(e.exhaustedUntil).getTime() > Date.now();

function NotConfigured() {
  return (
    <p role="alert" className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning">
      Executors are not configured on the server: <code className="font-mono">EXECUTOR_SECRET_KEY</code> is missing. Ask the
      administrator to set it before adding an executor.
    </p>
  );
}

function FormError({ error }: { error: unknown }) {
  if (error == null || (error instanceof ApiError && error.issues.length > 0)) return null;
  if (isNotConfigured(error)) return <NotConfigured />;
  return (
    <p role="alert" className="text-sm text-danger">
      {errorText(error)}
    </p>
  );
}

function RepoPicker({
  repos,
  selected,
  onChange,
  error,
}: {
  repos: Repo[];
  selected: string[];
  onChange: (ids: string[]) => void;
  error: unknown;
}) {
  const known = new Set(repos.map((r) => r.id));
  const options = [
    ...repos.map((r) => ({ id: r.id, label: r.fullName })),
    ...selected.filter((id) => !known.has(id)).map((id) => ({ id, label: id })),
  ];
  const messages = issueMessages(error, 'repoIds');
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">Repos</legend>
      {options.length === 0 && <p className="text-sm text-muted-foreground">No repos in the selected project.</p>}
      {options.map((o) => (
        <label key={o.id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={selected.includes(o.id)}
            onChange={(e) => onChange(e.target.checked ? [...selected, o.id] : selected.filter((id) => id !== o.id))}
          />
          <span className="font-mono">{o.label}</span>
        </label>
      ))}
      {messages.length > 0 && (
        <p role="alert" className="text-sm text-danger">
          {messages.join(', ')}
        </p>
      )}
    </fieldset>
  );
}

/** Add (no `executor`) or edit. The token is only asked when adding; it is read from the form on submit, never kept in state. */
function ExecutorDialog({
  executor,
  repos,
  onClose,
  onSaved,
}: {
  executor?: Executor;
  repos: Repo[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState(executor?.name ?? '');
  const [fireUrl, setFireUrl] = useState(executor?.fireUrl ?? '');
  const [repoIds, setRepoIds] = useState<string[]>(executor?.repoIds ?? []);
  const [maxConcurrent, setMaxConcurrent] = useState(String(executor?.maxConcurrent ?? 1));
  const [dailyLimit, setDailyLimit] = useState(executor?.dailyRunLimit != null ? String(executor.dailyRunLimit) : '');
  const [enabled, setEnabled] = useState(executor?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const token = executor ? '' : String(new FormData(form).get('token') ?? '');
    const limits = {
      maxConcurrent: Number(maxConcurrent),
      dailyRunLimit: dailyLimit.trim() ? Number(dailyLimit) : null,
    };
    setBusy(true);
    setError(null);
    try {
      if (executor) {
        await api.replaceExecutor(executor.id, executorReplacement(executor, {
          name: name.trim(), fireUrl: fireUrl.trim(), repoIds, enabled, ...limits,
        }));
      } else {
        await api.createExecutor({ name: name.trim(), fireUrl: fireUrl.trim(), token, repoIds, enabled, ...limits });
      }
      form.reset();
      await onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(32rem,92vw)]">
        <DialogTitle>{executor ? `Edit ${executor.name}` : 'Add executor'}</DialogTitle>
        <DialogDescription>
          {executor ? 'Settings of this routine. The token is replaced separately.' : 'A Claude Code routine that runs your jobs.'}
        </DialogDescription>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <Field label="Name" path="name" error={error}>
            <Input value={name} required maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Routine fire URL" path="fireUrl" error={error}>
            <Input
              className="font-mono"
              value={fireUrl}
              required
              placeholder="https://api.anthropic.com/v1/claude_code/routines/…/fire"
              onChange={(e) => setFireUrl(e.target.value)}
            />
          </Field>
          {!executor && (
            <Field label="Token" path="token" error={error} hint="Stored encrypted and never shown again.">
              <Input name="token" type="password" autoComplete="off" required />
            </Field>
          )}
          <RepoPicker repos={repos} selected={repoIds} onChange={setRepoIds} error={error} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Max concurrent" path="maxConcurrent" error={error}>
              <Input type="number" min={1} max={10} required value={maxConcurrent} onChange={(e) => setMaxConcurrent(e.target.value)} />
            </Field>
            <Field label="Daily run limit" path="dailyRunLimit" error={error} hint="Empty means no limit.">
              <Input type="number" min={1} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
          <FormError error={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {executor ? 'Save' : 'Add executor'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Replaces the token. The value is read from the form on submit and never prefilled or kept in state. */
function TokenDialog({ executor, onClose, onSaved }: { executor: Executor; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const token = String(new FormData(form).get('token') ?? '');
    setBusy(true);
    setError(null);
    try {
      await api.replaceExecutorToken(executor.id, token);
      form.reset();
      await onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(28rem,92vw)]">
        <DialogTitle>Replace token of {executor.name}</DialogTitle>
        <DialogDescription>The current token is never shown. The new one is stored encrypted.</DialogDescription>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <Field label="New token" path="token" error={error}>
            <Input name="token" type="password" autoComplete="off" required />
          </Field>
          <FormError error={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Replace token
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ executor, onClose, onDeleted }: { executor: Executor; onClose: () => void; onDeleted: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteExecutor(executor.id);
      await onDeleted();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(26rem,92vw)]">
        <DialogTitle>Delete {executor.name}?</DialogTitle>
        <DialogDescription>Its token is removed. Jobs can no longer run on it.</DialogDescription>
        <div className="mt-4 space-y-3">
          <FormError error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={confirm}>
              Delete
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type Dialogs = { kind: 'add' } | { kind: 'edit' | 'token' | 'delete'; id: string } | null;

export function ExecutorsView() {
  const { project, projectId, loading: projectLoading, projects } = useProject();
  const executors = usePolling(api.listExecutors, 30_000);
  const loadRepos = useCallback(() => (projectId ? api.listRepos(projectId) : Promise.resolve([] as Repo[])), [projectId]);
  const repos = usePolling(loadRepos, 60_000);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const list = executors.data;
  const repoNames = new Map((repos.data ?? []).map((r) => [r.id, r.fullName]));
  const current = dialog && dialog.kind !== 'add' ? list?.find((x) => x.id === dialog.id) : undefined;
  const close = () => setDialog(null);

  const toggle = async (id: string) => {
    // Built from the latest loaded executor, not from a copy captured when the row rendered.
    const latest = executors.data?.find((x) => x.id === id);
    if (!latest) return;
    setActionError(null);
    try {
      await api.replaceExecutor(id, executorReplacement(latest, { enabled: !latest.enabled }));
    } catch (err) {
      setActionError(err);
    }
    await executors.refresh();
  };

  const addButton = (
    <Button icon={Plus} onClick={() => setDialog({ kind: 'add' })}>
      Add executor
    </Button>
  );

  if (!projectLoading && projects && projects.length === 0) return <NoProjects />;

  return (
    <>
      <PageHeader
        className="px-4 pt-4"
        title="My executors"
        description="A Claude Code routine of your own. Jobs you own only run on your own executors, never on someone else's."
        actions={list && list.length > 0 ? addButton : undefined}
      />
      <div className="space-y-3 px-4 pb-4 pt-4">
        {actionError != null && (isNotConfigured(actionError) ? <NotConfigured /> : <p role="alert" className="text-sm text-danger">{errorText(actionError)}</p>)}
        {executors.loading && !list && (
          <div role="status" aria-label="Loading executors" className="space-y-2">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        )}
        {executors.error && !list && (
          isNotConfigured(executors.error) ? (
            <NotConfigured />
          ) : (
            <div role="alert" className="flex items-center gap-3 text-sm text-danger">
              <span>{errorText(executors.error)}</span>
              <Button size="sm" variant="outline" onClick={() => void executors.refresh()}>
                Retry
              </Button>
            </div>
          )
        )}
        {list && list.length === 0 && (
          <EmptyState icon={Server} title="No executors yet" text="Add your own routine so your jobs can run." action={addButton} />
        )}
        {list?.map((x) => (
          <article key={x.id} aria-label={x.name} className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-md font-semibold">{x.name}</h2>
              <Badge variant={x.enabled ? 'success' : 'neutral'} dot>
                {x.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
              {isActiveExhaustion(x) && <Badge variant="warning">Exhausted until {formatDate(x.exhaustedUntil!)}</Badge>}
            </div>
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Fire URL</dt>
                <dd className="break-all font-mono">{x.fireUrl}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Token</dt>
                <dd className="font-mono">{maskedToken(x)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Repos</dt>
                <dd className="font-mono">
                  {x.repoIds.length === 0 ? '—' : x.repoIds.map((id) => repoNames.get(id) ?? id).join(', ')}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Max concurrent</dt>
                <dd>{x.maxConcurrent}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Daily limit</dt>
                <dd>{x.dailyRunLimit ?? 'No limit'}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'edit', id: x.id })} aria-label={`Edit ${x.name}`}>
                Edit
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'token', id: x.id })} aria-label={`Replace token of ${x.name}`}>
                Replace token
              </Button>
              <Button size="sm" variant="outline" onClick={() => void toggle(x.id)} aria-label={`${x.enabled ? 'Disable' : 'Enable'} ${x.name}`}>
                {x.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button size="sm" variant="danger" onClick={() => setDialog({ kind: 'delete', id: x.id })} aria-label={`Delete ${x.name}`}>
                Delete
              </Button>
            </div>
          </article>
        ))}
      </div>
      {dialog?.kind === 'add' && (
        <ExecutorDialog repos={repos.data ?? []} onClose={close} onSaved={executors.refresh} />
      )}
      {dialog?.kind === 'edit' && current && (
        <ExecutorDialog key={current.id} executor={current} repos={repos.data ?? []} onClose={close} onSaved={executors.refresh} />
      )}
      {dialog?.kind === 'token' && current && <TokenDialog executor={current} onClose={close} onSaved={executors.refresh} />}
      {dialog?.kind === 'delete' && current && <DeleteDialog executor={current} onClose={close} onDeleted={executors.refresh} />}
    </>
  );
}
