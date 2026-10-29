import { GitMerge } from 'lucide-react';
import type { Job } from '@/lib/api';
import { Badge } from './ui/badge';

/** Warns that GitHub reports merge conflicts on the job's open PR; renders nothing otherwise. */
export function MergeConflictBadge({ job }: { job: Pick<Job, 'mergeConflict'> }) {
  if (!job.mergeConflict) return null;
  return (
    <Badge variant="warning" icon={GitMerge} title="The PR conflicts with the default branch">
      Merge conflicts
    </Badge>
  );
}
