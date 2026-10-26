import type { Feature, JobStatus } from '@/lib/api';
import { Badge } from './ui/badge';

type Progress = Feature['progress'];

export const PROGRESS_SEGMENTS = [
  { key: 'merged', label: 'merged', statuses: ['merged'], bar: 'bg-success' },
  { key: 'inProgress', label: 'in progress', statuses: ['dispatched', 'pr_open', 'awaiting_review'], bar: 'bg-info' },
  { key: 'waiting', label: 'waiting', statuses: ['triage', 'queued'], bar: 'bg-warning' },
  { key: 'failed', label: 'blocked or failed', statuses: ['parked', 'rejected'], bar: 'bg-danger' },
] as const satisfies readonly { key: string; label: string; statuses: JobStatus[]; bar: string }[];

/** Job counts per progress segment, from the job statuses (cancelled jobs are not counted). */
export function progressCounts(progress: Progress) {
  return PROGRESS_SEGMENTS.map((s) => ({
    ...s,
    count: s.statuses.reduce((n, st) => n + (progress.countByStatus?.[st] ?? 0), 0),
  }));
}

export function progressText(progress: Progress): string {
  const parts = progressCounts(progress).map((s) => `${s.count} ${s.label}`);
  return `${parts.join(', ')} of ${progress.total} jobs`;
}

export function FeatureProgressBar({ progress }: { progress: Progress }) {
  const segments = progressCounts(progress);
  const text = progressText(progress);
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <div
        role="progressbar"
        aria-label="Job progress"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.merged}
        aria-valuetext={text}
        title={text}
        className="flex h-2 w-32 overflow-hidden rounded bg-muted"
      >
        {progress.total > 0 &&
          segments
            .filter((s) => s.count > 0)
            .map((s) => <div key={s.key} data-segment={s.key} className={`h-full ${s.bar}`} style={{ width: `${(s.count / progress.total) * 100}%` }} />)}
      </div>
      <span>
        {progress.merged}/{progress.total} merged
      </span>
      <span className="sr-only">{text}</span>
    </div>
  );
}

export function ReadyToCloseBadge({ feature }: { feature: Feature }) {
  if (!feature.progress.readyToClose) return null;
  return <Badge variant="success">Ready to close</Badge>;
}
