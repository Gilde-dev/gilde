'use client';

import { useState } from 'react';
import { Wrench } from 'lucide-react';
import { api, type Job, type OperatorAction, type OperatorActionWhen } from '@/lib/api';
import { humanOnlyErrorText } from '@/lib/job-actions';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

/** Warns that the job's latest run lists manual steps that are not all done; renders nothing otherwise. */
export function OperatorActionBadge({ job }: { job: Pick<Job, 'needsOperatorAction'> }) {
  if (!job.needsOperatorAction) return null;
  return (
    <Badge variant="warning" icon={Wrench} title="The PR needs manual steps (env, permission, CLI, infra)">
      Needs operator action
    </Badge>
  );
}

const GROUPS: Array<{ when: OperatorActionWhen; label: string }> = [
  { when: 'before_deploy', label: 'Before deploy' },
  { when: 'after_deploy', label: 'After deploy' },
];

/** The job's operator actions grouped by before/after deploy, each with a "Mark done". Marking never changes the job's status. */
export function OperatorActionsList({ job, onChanged }: { job: Pick<Job, 'id' | 'operatorActions'>; onChanged: () => void | Promise<void> }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = job.operatorActions ?? [];
  if (actions.length === 0) return null;

  const markDone = async (index: number) => {
    setBusy(index);
    setError(null);
    try {
      await api.markOperatorActionDone(job.id, index);
      await onChanged();
    } catch (e) {
      setError(humanOnlyErrorText(e, 'mark operator actions done'));
    } finally {
      setBusy(null);
    }
  };

  // Group while keeping each action's index in the run's list, which is what the API addresses.
  const indexed = actions.map((action, index) => ({ action, index }));
  return (
    <section aria-label="Operator actions" className="space-y-2">
      <h3 className="text-sm font-semibold">Operator actions</h3>
      {GROUPS.map(({ when, label }) => {
        const items = indexed.filter((i) => i.action.when === when);
        if (items.length === 0) return null;
        return (
          <div key={when}>
            <h4 className="text-label text-muted-foreground">{label}</h4>
            <ul className="mt-1 space-y-2">
              {items.map(({ action, index }) => (
                <ActionRow key={index} action={action} busy={busy === index} onDone={() => markDone(index)} />
              ))}
            </ul>
          </div>
        );
      })}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

function ActionRow({ action, busy, onDone }: { action: OperatorAction; busy: boolean; onDone: () => void }) {
  return (
    <li className="flex flex-wrap items-start gap-2 rounded-md border border-border p-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="neutral">{action.kind}</Badge>
          {action.name && <code className="font-mono text-label">{action.name}</code>}
          {action.where && <span className="text-label text-muted-foreground">in {action.where}</span>}
          {!action.required && <Badge variant="neutral">optional</Badge>}
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words">{action.instruction}</p>
      </div>
      {action.doneAt ? (
        <Badge variant="success" title={`Done ${action.doneAt}`}>
          Done
        </Badge>
      ) : (
        <Button size="sm" variant="outline" disabled={busy} onClick={onDone}>
          Mark done
        </Button>
      )}
    </li>
  );
}
