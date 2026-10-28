'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api, repoReplacement, type ApiError, type Repo } from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Field } from './ui/field';
import { Input } from './ui/input';

/** Same rule as the API: upper case, digits and underscores, starting with a letter. */
export const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;
const FULL_NAME = /^[\w.-]+\/[\w.-]+$/;

/** Add a repo to a project (no `repo`), or edit one (everything except the full name). */
export function RepoDialog({
  open,
  projectId,
  repo,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  repo?: Repo;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [fullName, setFullName] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [fireUrl, setFireUrl] = useState('');
  const [tokenEnv, setTokenEnv] = useState('');
  const [concurrency, setConcurrency] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setFullName('');
    setDefaultBranch(repo?.defaultBranch ?? 'main');
    setFireUrl(repo?.routineFireUrl ?? '');
    setTokenEnv(repo?.routineTokenEnv ?? '');
    setConcurrency(String(repo?.maxConcurrentJobs ?? 1));
    setError(null);
  }, [open, repo]);

  const envInvalid = tokenEnv !== '' && !ENV_VAR_NAME.test(tokenEnv);
  const nameInvalid = !repo && fullName.trim() !== '' && !FULL_NAME.test(fullName.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (envInvalid || nameInvalid) return;
    setBusy(true);
    setError(null);
    try {
      const common = {
        defaultBranch: defaultBranch.trim() || undefined,
        maxConcurrentJobs: Number(concurrency),
      };
      if (repo) {
        // A blank branch keeps the loaded one; blank URL and token clear (null).
        await api.replaceRepo(repo.id, repoReplacement(repo, {
          ...common,
          routineFireUrl: fireUrl.trim() || null,
          routineTokenEnv: tokenEnv || null,
        }));
      } else {
        await api.createRepo(projectId, {
          fullName: fullName.trim(),
          ...common,
          ...(fireUrl.trim() ? { routineFireUrl: fireUrl.trim() } : {}),
          ...(tokenEnv ? { routineTokenEnv: tokenEnv } : {}),
        });
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(30rem,92vw)]">
        <DialogTitle>{repo ? `Edit ${repo.fullName}` : 'Add repo'}</DialogTitle>
        <DialogDescription>
          {repo ? 'Routine and dispatch settings for this repo.' : 'Register a GitHub repo in this project.'}
        </DialogDescription>
        <form onSubmit={submit} className="mt-4 space-y-3">
          {!repo && (
            <Field
              label="Full name"
              path="fullName"
              error={error}
              message={nameInvalid ? 'Use owner/name, e.g. gilde-dev/gilde' : undefined}
            >
              <Input value={fullName} placeholder="owner/repo" required onChange={(e) => setFullName(e.target.value)} />
            </Field>
          )}
          <Field label="Default branch" path="defaultBranch" error={error}>
            <Input value={defaultBranch} required onChange={(e) => setDefaultBranch(e.target.value)} />
          </Field>
          <Field label="Routine fire URL" path="routineFireUrl" error={error}>
            <Input type="url" value={fireUrl} placeholder="https://…" onChange={(e) => setFireUrl(e.target.value)} />
          </Field>
          <Field
            label="Routine token env var name"
            path="routineTokenEnv"
            error={error}
            message={envInvalid ? 'Use an UPPER_SNAKE_CASE env var name, e.g. ROUTINE_TOKEN_GILDE' : undefined}
            hint="This is the NAME of an environment variable on the API server that holds the routine token. The token itself is never entered or stored in Gilde."
          >
            <Input className="font-mono" value={tokenEnv} placeholder="ROUTINE_TOKEN_GILDE" onChange={(e) => setTokenEnv(e.target.value)} />
          </Field>
          <Field label="Max concurrent jobs" path="maxConcurrentJobs" error={error}>
            <Input type="number" min={1} max={10} value={concurrency} required onChange={(e) => setConcurrency(e.target.value)} />
          </Field>
          {error != null && (error as ApiError).issues?.length === 0 && (
            <p role="alert" className="text-sm text-danger">
              {errorText(error)}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || envInvalid || nameInvalid || (!repo && !fullName.trim())}>
              {repo ? 'Save' : 'Add repo'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
