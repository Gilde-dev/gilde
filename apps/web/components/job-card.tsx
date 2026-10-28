import { Clock, GitBranch, GitPullRequest, Repeat, Sparkles } from 'lucide-react';
import type { Job } from '@/lib/api';
import { JobActions } from './job-actions';
import { StatusBadge } from './status-badge';
import { Avatar } from './ui/avatar';
import { Badge } from './ui/badge';
import { Icon } from './ui/icon';
import { cn } from '@/lib/utils';
import { shortAge } from '@/lib/time';

/** Left-edge colour per status, matching the status badge colours (parked is red like rejected). */
export const STATUS_EDGE: Record<Job['status'], string> = {
  triage: 'border-l-muted-foreground',
  queued: 'border-l-info-solid',
  dispatched: 'border-l-running-solid',
  pr_open: 'border-l-pr-solid',
  awaiting_review: 'border-l-warning-solid',
  merged: 'border-l-success-solid',
  rejected: 'border-l-danger-solid',
  parked: 'border-l-danger-solid',
  cancelled: 'border-l-muted-foreground',
};

const blockedTitles = (job: Job) => job.blockedBy.map((b) => `${b.title} (${b.status})`).join('\n');

/** Elements inside the card that act on their own; activating them must not open the card. */
const NESTED_CONTROL = 'a, button, input, select, textarea, label, [role="checkbox"]';

/**
 * A job on the board. It shows only what the job list returns: no runs, feedback or CI.
 * The card itself opens the job (click, Enter or Space); links, checkboxes and actions inside it do not.
 */
export function JobCard({
  job,
  repoName,
  featureTitle,
  scoutUserId,
  onOpen,
  onChanged,
  onEnqueued,
  selected,
  onSelect,
}: {
  job: Job;
  repoName?: string;
  /** Title of the job's feature; shown as a badge. */
  featureTitle?: string;
  /** Id of the configured scout (Verkenner) user, read once for the board. A job created by exactly this user gets a "Suggested" badge. */
  scoutUserId?: string | null;
  onOpen: (job: Job) => void;
  onChanged?: () => void | Promise<void>;
  onEnqueued?: (warnings: string[]) => void;
  /** Set on triage cards, which can be picked for a bulk queue. */
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        // Events also bubble out of portals (the action dialogs) and from nested controls.
        const target = e.target as HTMLElement;
        if (!e.currentTarget.contains(target)) return;
        const nested = target.closest(NESTED_CONTROL);
        if (nested && e.currentTarget.contains(nested)) return;
        onOpen(job);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(job);
        }
      }}
      className={cn(
        'cursor-pointer rounded-lg border border-l-4 border-border bg-card p-3 text-left text-sm text-card-foreground shadow-sm',
        'transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-md motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        job.status === 'merged' && job.mergedBlocked ? 'border-l-warning-solid' : STATUS_EDGE[job.status],
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={job.status} mergedBlocked={job.mergedBlocked} />
        {scoutUserId && job.createdBy?.id === scoutUserId && (
          <Badge variant="pr" icon={Sparkles} title="Suggested by Verkenner, the scout">
            Suggested
          </Badge>
        )}
        {job.featureId && (
          <Badge variant="accent" className="max-w-full truncate" title={`Feature: ${featureTitle ?? job.featureId}`}>
            <span className="truncate">{featureTitle ?? 'feature'}</span>
          </Badge>
        )}
      </div>
      <div className="mt-1.5 truncate font-mono text-label text-muted-foreground" title={repoName ?? job.repoId}>
        {repoName ?? job.repoId}
      </div>
      <div className="mt-1 flex items-start gap-2">
        {onSelect && (
          <input
            type="checkbox"
            aria-label={`Select ${job.title}`}
            className="mt-1"
            checked={selected ?? false}
            onChange={(e) => onSelect(e.target.checked)}
          />
        )}
        <div className="min-w-0 break-words text-md font-semibold">{job.title}</div>
      </div>
      {job.task && <p className="mt-1 line-clamp-2 break-words text-sm text-muted-foreground">{job.task}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        {job.prNumber !== null && (
          <span className="inline-flex items-center gap-1">
            <Icon icon={GitPullRequest} size={14} />
            {job.prUrl ? (
              <a href={job.prUrl} target="_blank" rel="noreferrer" className="text-foreground underline">
                #{job.prNumber}
              </a>
            ) : (
              <span>#{job.prNumber}</span>
            )}
          </span>
        )}
        {job.branch && (
          <span className="inline-flex min-w-0 max-w-full items-center gap-1" title={job.branch}>
            <Icon icon={GitBranch} size={14} />
            <span className="truncate font-mono text-label">{job.branch}</span>
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <Icon icon={Repeat} size={14} />
          {job.attempts} {job.attempts === 1 ? 'attempt' : 'attempts'}
        </span>
        <span className="inline-flex items-center gap-1" title={`Updated ${job.updatedAt}`}>
          <Icon icon={Clock} size={14} />
          {shortAge(job.updatedAt)}
        </span>
        <span className="ml-auto" title={job.createdBy ? `Created by ${job.createdBy.name}` : 'Created by the system'}>
          <Avatar name={job.createdBy?.name} size={20} />
        </span>
      </div>
      {(job.failedDependency || job.blockedBy?.length > 0 || job.pendingRevisions > 0 || job.needsApproval) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {job.failedDependency ? (
            <Badge variant="danger" title={blockedTitles(job)}>
              dependency failed
            </Badge>
          ) : (
            job.blockedBy?.length > 0 && (
              <Badge variant="neutral" title={blockedTitles(job)}>
                waiting on {job.blockedBy.length}
              </Badge>
            )
          )}
          {job.pendingRevisions > 0 && (
            <Badge variant="info" title="An agent proposed a change to this job">
              proposal pending
            </Badge>
          )}
          {job.needsApproval && (
            <Badge variant="warning" title={job.approvalReason ?? undefined}>
              Needs approval
            </Badge>
          )}
        </div>
      )}
      {job.status === 'parked' && job.lastReason && (
        <p className="mt-2 truncate text-sm text-danger" title={job.lastReason}>
          {job.lastReason}
        </p>
      )}
      <div className="mt-2">
        <JobActions job={job} onChanged={onChanged ?? (() => {})} onEnqueued={onEnqueued} />
      </div>
    </div>
  );
}
