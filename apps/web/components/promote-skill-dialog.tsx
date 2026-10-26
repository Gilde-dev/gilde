'use client';

import { useState } from 'react';
import { STACKS, api, type PromoteSkillResult, type Repo, type Stack } from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

/** Promotes a repo-owned skill to the project's skills library. */
export function PromoteSkillDialog({
  repo,
  skillName,
  onClose,
  onPromoted,
}: {
  repo: Repo;
  skillName: string;
  onClose: () => void;
  onPromoted: () => void | Promise<void>;
}) {
  const [scope, setScope] = useState<'global' | 'stack'>('global');
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PromoteSkillResult | null>(null);

  const toggle = (s: Stack) => setStacks((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      setResult(await api.promoteSkill(repo.id, skillName, scope === 'stack' ? { scope, stacks } : { scope }));
      await onPromoted();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const boardHref = `/?project=${encodeURIComponent(repo.projectId)}`;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogTitle className="text-lg font-semibold">Promote {skillName}</DialogTitle>
        <DialogDescription className="mb-3 text-sm text-muted-foreground">
          Move this repo-owned skill from {repo.fullName} into the skills library. The repo copy is removed afterwards and comes back as a managed skill.
        </DialogDescription>
        {result ? (
          <div className="space-y-2 text-sm">
            <p>Created:</p>
            <ul className="list-disc pl-5">
              {result.libraryJobId && (
                <li>
                  <a className="underline" href={boardHref}>
                    Library job {result.libraryJobId.slice(0, 8)}
                  </a>
                </li>
              )}
              <li>
                <a className="underline" href={boardHref}>
                  Cleanup job {result.cleanupJobId.slice(0, 8)}
                </a>{' '}
                on {repo.fullName}
              </li>
            </ul>
            {!result.libraryJobId && <p className="text-muted-foreground">The skill was written to the library folder directly.</p>}
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <fieldset className="space-y-1">
              <legend className="font-medium">Scope</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name="scope" checked={scope === 'global'} onChange={() => setScope('global')} /> Global
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="scope" checked={scope === 'stack'} onChange={() => setScope('stack')} /> Stack
              </label>
            </fieldset>
            {scope === 'stack' && (
              <fieldset className="space-y-1">
                <legend className="font-medium">Stacks</legend>
                {STACKS.map((s) => (
                  <label key={s} className="flex items-center gap-2">
                    <input type="checkbox" checked={stacks.includes(s)} onChange={() => toggle(s)} /> {s}
                  </label>
                ))}
              </fieldset>
            )}
            {error && <p role="alert" className="text-danger">{error}</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={submit} disabled={saving || (scope === 'stack' && stacks.length === 0)}>
                Promote
              </Button>
              <Button size="sm" variant="outline" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
