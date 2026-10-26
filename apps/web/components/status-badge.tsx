import {
  Ban,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CirclePlay,
  CircleX,
  Clock,
  Eye,
  GitMerge,
  GitPullRequest,
  Inbox,
  LoaderCircle,
  type LucideIcon,
} from 'lucide-react';
import type { FeatureStatus, JobStatus } from '@/lib/api';
import { Badge, type BadgeVariant } from './ui/badge';

interface StatusEntry {
  label: string;
  variant: BadgeVariant;
  icon: LucideIcon;
}

export const JOB_STATUS_BADGE: Record<JobStatus, StatusEntry> = {
  triage: { label: 'Triage', variant: 'neutral', icon: Inbox },
  queued: { label: 'Queued', variant: 'info', icon: Clock },
  // "Running" is how a dispatched job is shown; the API status stays `dispatched`.
  dispatched: { label: 'Running', variant: 'running', icon: LoaderCircle },
  pr_open: { label: 'PR open', variant: 'pr', icon: GitPullRequest },
  awaiting_review: { label: 'Awaiting review', variant: 'warning', icon: Eye },
  merged: { label: 'Merged', variant: 'success', icon: GitMerge },
  rejected: { label: 'Rejected', variant: 'danger', icon: CircleX },
  parked: { label: 'Parked', variant: 'danger', icon: CirclePause },
  cancelled: { label: 'Cancelled', variant: 'neutral', icon: Ban },
};

export const FEATURE_STATUS_BADGE: Record<FeatureStatus, StatusEntry> = {
  draft: { label: 'Draft', variant: 'neutral', icon: CircleDashed },
  active: { label: 'Active', variant: 'running', icon: CirclePlay },
  done: { label: 'Done', variant: 'success', icon: CircleCheck },
  cancelled: { label: 'Cancelled', variant: 'neutral', icon: Ban },
};

export function StatusBadge({ status, kind = 'job', className }: { status: string; kind?: 'job' | 'feature'; className?: string }) {
  const map: Record<string, StatusEntry> = kind === 'job' ? JOB_STATUS_BADGE : FEATURE_STATUS_BADGE;
  const entry = map[status] ?? { label: status.replace(/_/g, ' '), variant: 'neutral' as const, icon: CircleDashed };
  return (
    <Badge variant={entry.variant} icon={entry.icon} className={className}>
      {entry.label}
    </Badge>
  );
}
