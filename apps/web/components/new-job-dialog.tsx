'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type ApiIssue, type Repo } from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

const inputClass = 'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground';

export function NewJobDialog({
  open,
  repos,
  onClose,
  onCreated,
}: {
  open: boolean;
  repos: Repo[];
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [repoId, setRepoId] = useState('');
  const [title, setTitle] = useState('');
  const [task, setTask] = useState('');
  const [criteria, setCriteria] = useState<string[]>(['']);
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Preselect the repo when there is only one; drop a selection that no longer exists.
  useEffect(() => {
    setRepoId((current) => (repos.some((r) => r.id === current) ? current : repos.length === 1 ? repos[0].id : ''));
  }, [repos]);

  function reset() {
    setTitle('');
    setTask('');
    setCriteria(['']);
    setIssues([]);
    setError(null);
  }

  const fieldErrors = (field: string) =>
    issues.filter((i) => i.path === field || i.path.startsWith(`${field}.`)).map((i) => i.message);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!repoId) {
      setError('Select a repo');
      return;
    }
    // Empty rows are dropped, so remember each sent criterion's row to place its errors.
    const sentRows = criteria.map((text, row) => ({ text: text.trim(), row })).filter((r) => r.text);
    setSaving(true);
    setIssues([]);
    setError(null);
    try {
      await api.createJob(repoId, { title, task, acceptanceCriteria: sentRows.map((r) => r.text) });
      await onCreated();
      reset();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.issues.length > 0) {
        setIssues(
          err.issues.map((i) => {
            const m = /^acceptanceCriteria\.(\d+)$/.exec(i.path);
            return m && sentRows[Number(m[1])] ? { ...i, path: `acceptanceCriteria.${sentRows[Number(m[1])].row}` } : i;
          }),
        );
      }
      else setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  const FieldErrors = ({ field }: { field: string }) => (
    <>
      {fieldErrors(field).map((m, i) => (
        <p key={i} role="alert" className="mt-1 text-xs text-red-800">
          {m}
        </p>
      ))}
    </>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogTitle className="text-lg font-semibold">New job</DialogTitle>
        <DialogDescription className="sr-only">Create a job in a repo of the selected project</DialogDescription>
        <form onSubmit={submit} className="mt-4 space-y-4">
          <div>
            <label htmlFor="job-repo" className="text-sm font-medium">
              Repo
            </label>
            <select id="job-repo" className={inputClass} value={repoId} onChange={(e) => setRepoId(e.target.value)}>
              <option value="">Select a repo…</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="job-title" className="text-sm font-medium">
              Title
            </label>
            <input id="job-title" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
            <FieldErrors field="title" />
          </div>
          <div>
            <label htmlFor="job-task" className="text-sm font-medium">
              Task
            </label>
            <textarea id="job-task" rows={5} className={inputClass} value={task} onChange={(e) => setTask(e.target.value)} />
            <FieldErrors field="task" />
          </div>
          <fieldset>
            <legend className="text-sm font-medium">Acceptance criteria</legend>
            <ul className="mt-1 space-y-2">
              {criteria.map((c, i) => (
                <li key={i}>
                  <div className="flex gap-2">
                    <input
                      aria-label={`Criterion ${i + 1}`}
                      className={inputClass}
                      value={c}
                      onChange={(e) => setCriteria((cs) => cs.map((x, j) => (j === i ? e.target.value : x)))}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove criterion ${i + 1}`}
                      onClick={() => setCriteria((cs) => cs.filter((_, j) => j !== i))}
                    >
                      ✕
                    </Button>
                  </div>
                  <FieldErrors field={`acceptanceCriteria.${i}`} />
                </li>
              ))}
            </ul>
            <FieldErrors field="acceptanceCriteria" />
            <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => setCriteria((cs) => [...cs, ''])}>
              Add criterion
            </Button>
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-red-800">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Creating…' : 'Create job'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
