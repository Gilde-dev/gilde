import { TriangleAlert } from 'lucide-react';
import type { DispatchReason, RepoDispatchReport } from '@/lib/api';
import { Icon } from './ui/icon';

const plural = (n: number, one: string) => `${n} job${n === 1 ? '' : 's'} ${one}`;

const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
const usd = (n: number) => `$${n.toFixed(2)}`;

/** Every blocker with scope, period and spend; the reset promise is only the latest one, never the first. */
function explainBudget(r: RepoDispatchReport): string {
  const b = r.budget;
  if (!b) return `Stopped by estimated budget${r.detail ? `: ${r.detail}` : ''}`;
  if (b.error) return 'Estimated budget could not be checked: new automatic dispatch is stopped';
  const parts = b.blockers.map((x) =>
    x.kind === 'configError'
      ? `${x.scope} ${x.period} (${x.variable ?? 'budget variable'} is invalid; a reset does not clear it)`
      : `${x.scope} ${x.period} ${usd(x.spent)} of ${x.limit === null ? '–' : usd(x.limit)} estimated, resets ${utc(x.resetsAt)}`,
  );
  const recovery =
    b.recovery === 'reset' && r.resetsAt
      ? `. Earliest automatic recovery ${utc(r.resetsAt)} (when all blockers have reset)`
      : '. Needs a limit or configuration change';
  return `Stopped by estimated budget: ${parts.join('; ')}${recovery}`;
}

/** One-line explanation of why a repo's queued jobs are not being fired; null when nothing is held back. */
export function explainRepo(r: RepoDispatchReport): string | null {
  const reasons: Record<Exclude<DispatchReason, 'none'>, () => string> = {
    repo_paused: () => `Repo paused${r.detail ? `: ${r.detail}` : ''}`,
    project_paused: () => 'Project paused',
    no_manifest: () => `No .gilde.json cached${r.detail ? `: ${r.detail}` : ''}`,
    no_slots: () => `No free slots (${r.detail ?? ''} running)`,
    daily_limit: () =>
      `Daily limit reached ${r.detail ?? ''}${r.resetsAt ? `, resets at ${new Date(r.resetsAt).toLocaleString()}` : ''}`,
    budget: () => explainBudget(r),
  };
  const parts: string[] = [];
  if (r.reason !== 'none') parts.push(reasons[r.reason]());
  if (r.waitingOnDependencies > 0) parts.push(plural(r.waitingOnDependencies, 'waiting on dependencies'));
  if (r.waitingOnRevisions > 0) parts.push(plural(r.waitingOnRevisions, 'waiting for a proposal decision'));
  if (r.waitingOnExecutor > 0) parts.push(plural(r.waitingOnExecutor, 'waiting for an executor of their owner'));
  return parts.length === 0 || (r.reason === 'none' && r.waitingOnExecutor === 0) ? null : parts.join(' · ');
}

export function DispatchStrip({ repos }: { repos: RepoDispatchReport[] }) {
  const held = repos
    .filter((r) => r.queued > 0 && (r.reason !== 'none' || r.waitingOnExecutor > 0))
    .map((r) => ({ r, text: explainRepo(r) }))
    .filter((x): x is { r: RepoDispatchReport; text: string } => x.text !== null);
  if (held.length === 0) return null;
  return (
    <ul aria-label="Dispatch status" className="mx-4 mt-4 space-y-1 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
      {held.map(({ r, text }) => (
        <li key={r.repoId} className="flex items-start gap-2">
          <Icon icon={TriangleAlert} size={14} className="mt-0.5" />
          <span>
            <span className="font-mono font-medium">{r.fullName}</span>: {text}
          </span>
        </li>
      ))}
    </ul>
  );
}
