import type { FeatureStatus, JobStatus } from '@/lib/api';
import { Badge, type BadgeVariant } from './ui/badge';

export const JOB_STATUS_BADGE: Record<JobStatus, { label: string; variant: BadgeVariant }> = {
  triage: { label: 'Triage', variant: 'neutral' },
  queued: { label: 'Queued', variant: 'info' },
  dispatched: { label: 'Dispatched', variant: 'accent' },
  pr_open: { label: 'PR open', variant: 'accent' },
  awaiting_review: { label: 'Awaiting review', variant: 'warning' },
  merged: { label: 'Merged', variant: 'success' },
  rejected: { label: 'Rejected', variant: 'danger' },
  parked: { label: 'Parked', variant: 'warning' },
  cancelled: { label: 'Cancelled', variant: 'neutral' },
};

export const FEATURE_STATUS_BADGE: Record<FeatureStatus, { label: string; variant: BadgeVariant }> = {
  draft: { label: 'Draft', variant: 'neutral' },
  active: { label: 'Active', variant: 'accent' },
  done: { label: 'Done', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'danger' },
};

export function StatusBadge({ status, kind = 'job', className }: { status: string; kind?: 'job' | 'feature'; className?: string }) {
  const map: Record<string, { label: string; variant: BadgeVariant }> = kind === 'job' ? JOB_STATUS_BADGE : FEATURE_STATUS_BADGE;
  const entry = map[status] ?? { label: status.replace(/_/g, ' '), variant: 'neutral' as const };
  return (
    <Badge variant={entry.variant} className={className}>
      {entry.label}
    </Badge>
  );
}

