import type { JobStatus } from './api';

export function canCancel(status: JobStatus): boolean {
  return status === 'queued' || status === 'dispatched' || status === 'parked';
}

export function canRetry(status: JobStatus): boolean {
  return status === 'parked';
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return (e as { detail?: string }).detail ?? e.message;
  return String(e);
}
