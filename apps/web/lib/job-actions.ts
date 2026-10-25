import type { JobStatus } from './api';

export function canCancel(status: JobStatus): boolean {
  return status === 'triage' || status === 'queued' || status === 'dispatched' || status === 'parked';
}

export function canRetry(status: JobStatus): boolean {
  return status === 'parked';
}

export function canSendBack(status: JobStatus): boolean {
  return status === 'pr_open' || status === 'awaiting_review';
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

export function errorText(e: unknown): string {
  if (e instanceof Error) return (e as { detail?: string }).detail ?? e.message;
  return String(e);
}
