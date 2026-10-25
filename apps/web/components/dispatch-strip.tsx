import type { DispatchReason, RepoDispatchReport } from '@/lib/api';

const plural = (n: number, one: string) => `${n} job${n === 1 ? '' : 's'} ${one}`;

/** One-line explanation of why a repo's queued jobs are not being fired; null when nothing is held back. */
export function explainRepo(r: RepoDispatchReport): string | null {
  const reasons: Record<Exclude<DispatchReason, 'none'>, () => string> = {
    repo_paused: () => `Repo paused${r.detail ? `: ${r.detail}` : ''}`,
    project_paused: () => 'Project paused',
    no_routine: () => 'No routine configured',
    no_manifest: () => `No .gilde.json cached${r.detail ? `: ${r.detail}` : ''}`,
    no_slots: () => `No free slots (${r.detail ?? ''} running)`,
    daily_limit: () =>
      `Daily limit reached ${r.detail ?? ''}${r.resetsAt ? `, resets at ${new Date(r.resetsAt).toLocaleString()}` : ''}`,
  };
  const parts: string[] = [];
  if (r.reason !== 'none') parts.push(reasons[r.reason]());
  if (r.waitingOnDependencies > 0) parts.push(plural(r.waitingOnDependencies, 'waiting on dependencies'));
  if (r.waitingOnRevisions > 0) parts.push(plural(r.waitingOnRevisions, 'waiting for a proposal decision'));
  return r.reason === 'none' ? null : parts.join(' · ');
}

export function DispatchStrip({ repos }: { repos: RepoDispatchReport[] }) {
  const held = repos
    .filter((r) => r.queued > 0 && r.reason !== 'none')
    .map((r) => ({ r, text: explainRepo(r) }))
    .filter((x): x is { r: RepoDispatchReport; text: string } => x.text !== null);
  if (held.length === 0) return null;
  return (
    <ul aria-label="Dispatch status" className="mx-4 mt-3 space-y-0.5 rounded-md border bg-muted/60 px-3 py-2 text-xs">
      {held.map(({ r, text }) => (
        <li key={r.repoId}>
          <span className="font-medium">{r.fullName}</span>: {text}
        </li>
      ))}
    </ul>
  );
}
