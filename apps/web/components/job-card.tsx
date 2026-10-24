import type { Job } from '@/lib/api';
import { JobActions } from './job-actions';
import { relativeTime } from '@/lib/time';

const blockedTitles = (job: Job) => job.blockedBy.map((b) => `${b.title} (${b.status})`).join('\n');

export function JobCard({
  job,
  repoName,
  onOpen,
  onChanged,
  onEnqueued,
  selected,
  onSelect,
}: {
  job: Job;
  repoName?: string;
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
      className="cursor-pointer rounded-md border border-border bg-card p-3 text-left text-sm shadow-sm hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
        {job.failedDependency ? (
          <span
            className="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-900"
            title={blockedTitles(job)}
          >
            dependency failed
          </span>
        ) : (
          job.blockedBy?.length > 0 && (
            <span
              className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-900"
              title={blockedTitles(job)}
            >
              waiting on {job.blockedBy.length}
            </span>
          )
        )}
        {job.needsApproval && (
          <span
            className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900"
            title={job.approvalReason ?? undefined}
          >
            Needs approval
          </span>
        )}
      </div>
      {job.status === 'parked' && job.lastReason && (
        <p className="mt-2 truncate text-xs text-red-800" title={job.lastReason}>
          {job.lastReason}
        </p>
      )}
      <div className="mt-2">
        <JobActions job={job} onChanged={onChanged ?? (() => {})} onEnqueued={onEnqueued} />
      </div>
    </div>
  );
}

