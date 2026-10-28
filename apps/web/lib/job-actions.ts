import type { Job, JobStatus, JobSyncResult, ReconcileResult } from './api';

export function canCancel(status: JobStatus): boolean {
  return status === 'triage' || status === 'queued' || status === 'dispatched' || status === 'parked';
}

export function canRetry(status: JobStatus): boolean {
  return status === 'parked';
}

/** Merged on GitHub without work (blocked) and not replaced yet. */
export function canRecreate(job: Pick<Job, 'status' | 'mergedBlocked' | 'replacedById'>): boolean {
  return job.status === 'merged' && job.mergedBlocked === true && !job.replacedById;
}

export function canSendBack(status: JobStatus): boolean {
  return status === 'pr_open' || status === 'awaiting_review';
}

/** Mirrors the server: watched statuses always; parked, merged and rejected only with a PR (merged/rejected refresh CI only). */
export function canSync(job: Pick<Job, 'status' | 'prNumber'>): boolean {
  switch (job.status) {
    case 'dispatched':
    case 'pr_open':
    case 'awaiting_review':
      return true;
    case 'parked':
    case 'merged':
    case 'rejected':
      return job.prNumber !== null;
    default:
      return false;
  }
}

/** One accessible sentence for the result of a sync. */
export function describeSync(r: JobSyncResult): string {
  if (!r.pr) return 'No PR found on GitHub for this job yet. Nothing changed.';
  const state = r.pr.merged ? 'merged' : r.pr.state;
  const head = `PR #${r.pr.number} is ${state}`;
  const ci = r.ciConclusion ? `CI ${r.ciConclusion}` : r.pr.state === 'open' ? 'CI pending' : null;
  if (r.changes.length === 0) return `Nothing changed: ${[head, ci].filter(Boolean).join(', ')}`;
  if (r.before.status !== r.after.status) return `${head}: moved to ${r.after.status}`;
  return `${head}: ${r.changes.join('; ')}`;
}

export function describeReconcile(r: ReconcileResult): string {
  const jobs = `${r.checked} job${r.checked === 1 ? '' : 's'}`;
  return r.corrected === 0 ? `Checked ${jobs}; nothing needed correcting.` : `Checked ${jobs}; corrected ${r.corrected}.`;
}

export function canEnqueue(status: JobStatus): boolean {
  return status === 'triage';
}

export function canTriage(status: JobStatus): boolean {
  return status === 'queued';
}

/** One line per warning, prefixed with the job it belongs to. */
export function warningLines(results: { title: string; warnings: { message: string }[] }[]): string[] {
  return results.flatMap((r) => r.warnings.map((w) => `${r.title}: ${w.message}`));
}

/** Like errorText, with a plain message for a refused (403) human-only action. */
export function humanOnlyErrorText(e: unknown, what: string): string {
  if ((e as { status?: number } | null)?.status === 403) return `Only a signed-in person can ${what}. API keys and bot accounts cannot.`;
  return errorText(e);
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return (e as { detail?: string }).detail ?? e.message;
  return String(e);
}
