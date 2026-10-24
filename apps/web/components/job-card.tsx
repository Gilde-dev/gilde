import type { Job } from '@/lib/api';
import { relativeTime } from '@/lib/time';

export function JobCard({ job, repoName, onOpen }: { job: Job; repoName?: string; onOpen: (job: Job) => void }) {
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
      <div className="font-medium leading-snug">{job.title}</div>
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
      </div>
      {job.status === 'parked' && job.lastReason && (
        <p className="mt-2 truncate text-xs text-red-800" title={job.lastReason}>
          {job.lastReason}
        </p>
      )}
    </div>
  );
}

