'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api, repoReplacement, type ApiError, type Repo } from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Field } from './ui/field';
import { Input } from './ui/input';

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
  const [concurrency, setConcurrency] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setFullName('');
    setDefaultBranch(repo?.defaultBranch ?? 'main');
    setConcurrency(String(repo?.maxConcurrentJobs ?? 1));
    setError(null);
  }, [open, repo]);

  const nameInvalid = !repo && fullName.trim() !== '' && !FULL_NAME.test(fullName.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (nameInvalid) return;
    setBusy(true);
    setError(null);
    try {
      const common = {
        defaultBranch: defaultBranch.trim() || undefined,
        maxConcurrentJobs: Number(concurrency),
      };
      if (repo) {
        // A blank branch keeps the loaded one.
        await api.replaceRepo(repo.id, repoReplacement(repo, common));
      } else {
        await api.createRepo(projectId, {
          fullName: fullName.trim(),
          ...common,
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
          {repo ? 'Dispatch settings for this repo.' : 'Register a GitHub repo in this project.'}
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
          <Field label="Max concurrent jobs" path="maxConcurrentJobs" error={error}>
            <Input type="number" min={1} max={10} value={concurrency} required onChange={(e) => setConcurrency(e.target.value)} />
          </Field>
          <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            Capacity now comes from personal executors. Each user adds their own Claude Code routine under{' '}
            <a href="/settings/executors" className="underline">
              Settings &gt; Executors
            </a>
            ; this repo no longer has a routine of its own.
          </p>
          {error != null && (error as ApiError).issues?.length === 0 && (
            <p role="alert" className="text-sm text-danger">
              {errorText(error)}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || nameInvalid || (!repo && !fullName.trim())}>
              {repo ? 'Save' : 'Add repo'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
