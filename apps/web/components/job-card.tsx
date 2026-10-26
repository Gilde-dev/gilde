import type { Job } from '@/lib/api';
import { JobActions } from './job-actions';
import { relativeTime } from '@/lib/time';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

const blockedTitles = (job: Job) => job.blockedBy.map((b) => `${b.title} (${b.status})`).join('\n');

export function JobCard({
  job,
  repoName,
  featureTitle,
  onOpen,
  onChanged,
  onEnqueued,
  selected,
  onSelect,
}: {
  job: Job;
  repoName?: string;
  /** Title of the job's feature; shown as a chip. */
  featureTitle?: string;
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
      onClick={() => onOpen(job)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(job);
        }
      }}
      className="cursor-pointer rounded-md border border-border bg-card p-3 text-left text-sm shadow-sm hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start gap-2">
        {onSelect && (
          <input
            type="checkbox"
            aria-label={`Select ${job.title}`}
            className="mt-1"
            checked={selected ?? false}
            onChange={(e) => onSelect(e.target.checked)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
        )}
        <div className="font-medium leading-snug">{job.title}</div>
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{repoName ?? job.repoId}</div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          {job.attempts} {job.attempts === 1 ? 'attempt' : 'attempts'}
        </span>
        {job.prNumber !== null &&
          (job.prUrl ? (
            <a
              href={job.prUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-foreground underline"
            >
              #{job.prNumber}
            </a>
          ) : (
            <span>#{job.prNumber}</span>
          ))}
        <span>{relativeTime(job.updatedAt)}</span>
        <span
          className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground"
          title={job.createdBy ? `Created by ${job.createdBy.name}` : 'Created by the system'}
        >
          {job.createdBy ? initials(job.createdBy.name) : 'System'}
        </span>
        {job.failedDependency ? (
          <span
            className="rounded bg-danger-soft px-1.5 py-0.5 font-medium text-danger"
            title={blockedTitles(job)}
          >
            dependency failed
          </span>
        ) : (
          job.blockedBy?.length > 0 && (
            <span
              className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground"
              title={blockedTitles(job)}
            >
              waiting on {job.blockedBy.length}
            </span>
          )
        )}
        {job.featureId && (
          <span
            className="max-w-full truncate rounded bg-accent-soft px-1.5 py-0.5 font-medium text-accent"
            title={`Feature: ${featureTitle ?? job.featureId}`}
          >
            {featureTitle ?? 'feature'}
          </span>
        )}
        {job.pendingRevisions > 0 && (
          <span className="rounded bg-info-soft px-1.5 py-0.5 font-medium text-info" title="An agent proposed a change to this job">
            proposal pending
          </span>
        )}
        {job.needsApproval && (
          <span
            className="rounded bg-warning-soft px-1.5 py-0.5 font-medium text-warning"
            title={job.approvalReason ?? undefined}
          >
            Needs approval
          </span>
        )}
      </div>
      {job.status === 'parked' && job.lastReason && (
        <p className="mt-2 truncate text-xs text-danger" title={job.lastReason}>
          {job.lastReason}
        </p>
      )}
      <div className="mt-2">
        <JobActions job={job} onChanged={onChanged ?? (() => {})} onEnqueued={onEnqueued} />
      </div>
    </div>
  );
}

