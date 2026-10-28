'use client';

import { Check, Copy, Plus, Server } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, executorReplacement, type Executor, type Repo } from '@/lib/api';
import { FIRE_URL_HINT, isFireUrl } from '@/lib/fire-url';
import { errorText } from '@/lib/job-actions';
import { ROUTINE_DESCRIPTION } from '@/lib/routine-description';
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

/** Edit an existing executor (a single form). The token is replaced separately. */
function ExecutorDialog({
  executor,
  repos,
  onClose,
  onSaved,
}: {
  executor: Executor;
  repos: Repo[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState(executor.name);
  const [fireUrl, setFireUrl] = useState(executor.fireUrl);
  const [repoIds, setRepoIds] = useState<string[]>(executor.repoIds);
  const [maxConcurrent, setMaxConcurrent] = useState(String(executor.maxConcurrent));
  const [dailyLimit, setDailyLimit] = useState(executor.dailyRunLimit != null ? String(executor.dailyRunLimit) : '');
  const [enabled, setEnabled] = useState(executor.enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.replaceExecutor(executor.id, executorReplacement(executor, {
        name: name.trim(), fireUrl: fireUrl.trim(), repoIds, enabled,
        maxConcurrent: Number(maxConcurrent),
        dailyRunLimit: dailyLimit.trim() ? Number(dailyLimit) : null,
      }));
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
        <DialogTitle>Edit {executor.name}</DialogTitle>
        <DialogDescription>Settings of this routine. The token is replaced separately.</DialogDescription>
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
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const STEPS = ['Create a routine in Claude Code', 'Add an API trigger', 'Paste the fire URL and token', 'Name and scope'] as const;
const LAST_STEP = STEPS.length;
const FIRE_DOCS_URL = 'https://platform.claude.com/docs/en/api/claude-code/routines-fire';
const TOKEN_PREFIX = 'sk-ant-oat01-';
/** The step that owns a field of the create request, so an API field error can jump back to it. */
const FIELD_STEP: Record<string, number> = { fireUrl: 3, token: 3, name: 4, repoIds: 4, maxConcurrent: 4, dailyRunLimit: 4, enabled: 4 };

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  );
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted p-3">
      <p className="text-sm">{text}</p>
      <Button type="button" size="sm" variant="outline" icon={copied ? Check : Copy} onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy description'}
      </Button>
    </div>
  );
}

/**
 * Add an executor step by step. The token lives only in an uncontrolled password input that stays mounted (hidden) while
 * the user is on another step; state holds just whether it is empty and whether it has the usual prefix.
 */
function ExecutorWizard({ repos, onClose, onSaved }: { repos: Repo[]; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [fireUrl, setFireUrl] = useState('');
  const [tokenState, setTokenState] = useState<'empty' | 'prefixed' | 'other'>('empty');
  const [repoIds, setRepoIds] = useState<string[]>([]);
  const [maxConcurrent, setMaxConcurrent] = useState('1');
  const [dailyLimit, setDailyLimit] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const fireUrlOk = isFireUrl(fireUrl);
  const stepValid = step === 3 ? fireUrlOk && tokenState !== 'empty' : step === LAST_STEP ? name.trim().length > 0 : true;
  const fireUrlMessage = fireUrl.trim() && !fireUrlOk ? FIRE_URL_HINT : undefined;
  const limits = { maxConcurrent: Number(maxConcurrent), dailyRunLimit: dailyLimit.trim() ? Number(dailyLimit) : null };

  const next = () => stepValid && setStep((s) => Math.min(LAST_STEP, s + 1));
  const back = () => setStep((s) => Math.max(1, s - 1));

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (step < LAST_STEP) return next();
    const input = tokenRef.current;
    if (!input || !stepValid || !fireUrlOk || tokenState === 'empty') return;
    setBusy(true);
    setError(null);
    try {
      await api.createExecutor({ name: name.trim(), fireUrl: fireUrl.trim(), token: input.value, repoIds, enabled, ...limits });
      input.value = '';
      await onSaved();
      onClose();
    } catch (err) {
      setError(err);
      const steps = err instanceof ApiError ? err.issues.map((i) => FIELD_STEP[i.path.split('.')[0]]).filter(Boolean) : [];
      if (steps.length > 0) setStep(Math.min(...steps));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="w-[min(36rem,92vw)]"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          headingRef.current?.focus();
        }}
      >
        <DialogTitle>Add executor</DialogTitle>
        <DialogDescription>A Claude Code routine that runs your jobs.</DialogDescription>
        <ol className="mt-3 flex gap-1" aria-label="Steps">
          {STEPS.map((title, i) => (
            <li
              key={title}
              aria-current={step === i + 1 ? 'step' : undefined}
              className={`h-1.5 flex-1 rounded-full ${i + 1 <= step ? 'bg-primary' : 'bg-muted'}`}
            >
              <span className="sr-only">{title}</span>
            </li>
          ))}
        </ol>
        <form onSubmit={submit} className="mt-3 space-y-3">
          <p className="text-label text-muted-foreground">
            Step {step} of {LAST_STEP}
          </p>
          <h3 ref={headingRef} tabIndex={-1} className="text-md font-semibold outline-none">
            {STEPS[step - 1]}
          </h3>

          {step === 1 && (
            <div className="space-y-3 text-sm">
              <p>
                Open <ExternalLink href="https://claude.ai/code/routines">claude.ai/code/routines</ExternalLink> and create a new routine
                on your own Claude account. Give it access to the repositories you want to work on, the same repos you tick in the last step.
              </p>
              <p>Paste this as the routine description:</p>
              <CopyBlock text={ROUTINE_DESCRIPTION} />
              <p className="text-muted-foreground">
                To see token usage, the routine&apos;s environment needs the OpenTelemetry settings from the README. The ingest token for
                them comes from the Gilde operator.
              </p>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3 text-sm">
              <ol className="list-decimal space-y-1 pl-5">
                <li>Open the routine for editing.</li>
                <li>Under &ldquo;Select a trigger&rdquo;, click &ldquo;Add another trigger&rdquo;.</li>
                <li>Choose &ldquo;API&rdquo;.</li>
                <li>Click &ldquo;Generate token&rdquo;.</li>
              </ol>
              <p>
                The modal shows the fire URL (<code className="font-mono">https://api.anthropic.com/v1/claude_code/routines/trig_…/fire</code>)
                and the token (it starts with <code className="font-mono">{TOKEN_PREFIX}</code>).
              </p>
              <p role="note" className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-warning">
                The token is shown only once. Generating a new token revokes the previous one.
              </p>
              <p>
                <ExternalLink href={FIRE_DOCS_URL}>Routines fire documentation</ExternalLink>
              </p>
            </div>
          )}

          <div hidden={step !== 3} className="space-y-3">
            <Field label="Routine fire URL" path="fireUrl" error={error} message={fireUrlMessage}>
              <Input
                className="font-mono"
                value={fireUrl}
                placeholder="https://api.anthropic.com/v1/claude_code/routines/…/fire"
                onChange={(e) => setFireUrl(e.target.value)}
              />
            </Field>
            <Field
              label="Token"
              path="token"
              error={error}
              hint={
                tokenState === 'other'
                  ? `This does not start with ${TOKEN_PREFIX}. Check that you copied the token of the API trigger.`
                  : 'Stored encrypted and never shown again.'
              }
            >
              <Input
                ref={tokenRef}
                type="password"
                autoComplete="off"
                onChange={(e) => {
                  const v = e.target.value.trim();
                  setTokenState(!v ? 'empty' : v.startsWith(TOKEN_PREFIX) ? 'prefixed' : 'other');
                }}
              />
            </Field>
          </div>

          {step === LAST_STEP && (
            <div className="space-y-3">
              <Field label="Name" path="name" error={error}>
                <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
              </Field>
              <RepoPicker repos={repos} selected={repoIds} onChange={setRepoIds} error={error} />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Max concurrent" path="maxConcurrent" error={error}>
                  <Input type="number" min={1} max={10} value={maxConcurrent} onChange={(e) => setMaxConcurrent(e.target.value)} />
                </Field>
                <Field label="Daily run limit" path="dailyRunLimit" error={error} hint="Empty means no limit.">
                  <Input type="number" min={1} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                Enabled
              </label>
              <dl aria-label="Summary" className="space-y-1 rounded-lg border border-border bg-muted p-3 text-sm">
                <div><dt className="inline text-muted-foreground">Name: </dt><dd className="inline">{name.trim() || '—'}</dd></div>
                <div><dt className="inline text-muted-foreground">Fire URL: </dt><dd className="inline break-all font-mono">{fireUrl.trim()}</dd></div>
                <div>
                  <dt className="inline text-muted-foreground">Repos: </dt>
                  <dd className="inline font-mono">
                    {repoIds.length === 0 ? '—' : repoIds.map((id) => repos.find((r) => r.id === id)?.fullName ?? id).join(', ')}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">Limits: </dt>
                  <dd className="inline">{limits.maxConcurrent} concurrent, {limits.dailyRunLimit ?? 'no'} daily limit{enabled ? '' : ', disabled'}</dd>
                </div>
                <div><dt className="inline text-muted-foreground">Token: </dt><dd className="inline">set</dd></div>
              </dl>
            </div>
          )}

          <FormError error={error} />
          <div className="flex justify-end gap-2">
            {step > 1 && (
              <Button type="button" variant="outline" onClick={back}>
                Back
              </Button>
            )}
            {step < LAST_STEP ? (
              <Button type="button" disabled={!stepValid} onClick={next}>
                Next
              </Button>
            ) : (
              <Button type="submit" disabled={busy || !stepValid}>
                Create executor
              </Button>
            )}
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

  const resetExhaustion = async (id: string) => {
    setActionError(null);
    try {
      await api.resetExecutorExhaustion(id);
    } catch (err) {
      setActionError(err);
    }
    await executors.refresh();
  };

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
              {isActiveExhaustion(x) && (
                <Button size="sm" variant="outline" onClick={() => void resetExhaustion(x.id)} aria-label={`Clear exhaustion of ${x.name}`}>
                  Clear exhaustion
                </Button>
              )}
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
        <ExecutorWizard repos={repos.data ?? []} onClose={close} onSaved={executors.refresh} />
      )}
      {dialog?.kind === 'edit' && current && (
        <ExecutorDialog key={current.id} executor={current} repos={repos.data ?? []} onClose={close} onSaved={executors.refresh} />
      )}
      {dialog?.kind === 'token' && current && <TokenDialog executor={current} onClose={close} onSaved={executors.refresh} />}
      {dialog?.kind === 'delete' && current && <DeleteDialog executor={current} onClose={close} onDeleted={executors.refresh} />}
    </>
  );
}
