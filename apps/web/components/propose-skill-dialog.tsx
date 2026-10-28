'use client';

import { useState } from 'react';
import { STACKS, api, type LessonPattern, type ProposeSkillResult, type Stack } from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { withProject } from '@/lib/use-project';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';

const NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** Proposes a library skill for a lesson pattern: one triage job in the skills library repo; the lessons become applying. */
export function ProposeSkillDialog({
  projectId,
  pattern,
  onClose,
  onProposed,
}: {
  projectId: string;
  pattern: LessonPattern;
  onClose: () => void;
  onProposed: (result: ProposeSkillResult) => void;
}) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'global' | 'stack'>('global');
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProposeSkillResult | null>(null);

  const toggle = (s: Stack) => setStacks((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const nameOk = NAME.test(name);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const created = await api.proposeSkillFromPattern(projectId, pattern.id, { name, scope, ...(scope === 'stack' ? { stacks } : {}) });
      setResult(created);
      onProposed(created);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogTitle>Propose a skill</DialogTitle>
        <DialogDescription className="mb-3">
          Creates one triage job in the skills library repo from these {pattern.members.length} lessons. Nothing is queued or merged; the lessons become
          applying and are applied when the job merges.
        </DialogDescription>
        {result ? (
          <div className="space-y-2 text-sm">
            <p>
              Created{' '}
              <a className="underline" href={withProject(`/?job=${encodeURIComponent(result.jobId)}`, projectId)}>
                job {result.jobId.slice(0, 8)}
              </a>{' '}
              for the skill <span className="font-mono">{result.skillName}</span>.
            </p>
            <Button size="sm" onClick={onClose}>Close</Button>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <label className="block space-y-1">
              <span className="font-medium">Skill name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="pnpm-install-first" />
              {name && !nameOk && (
                <span className="text-danger">Use lowercase letters, digits, dots, dashes and underscores, starting with a letter or digit.</span>
              )}
            </label>
            <fieldset className="space-y-1">
              <legend className="font-medium">Scope</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name="skill-scope" checked={scope === 'global'} onChange={() => setScope('global')} /> Global
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="skill-scope" checked={scope === 'stack'} onChange={() => setScope('stack')} /> Stack
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
              <Button size="sm" onClick={submit} disabled={saving || !nameOk || (scope === 'stack' && stacks.length === 0)}>
                Create proposal job
              </Button>
              <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
