import type { Feature } from '@/lib/api';
import { Badge } from './ui/badge';

export function FeatureProgressBar({ progress }: { progress: Feature['progress'] }) {
  const pct = progress.total === 0 ? 0 : Math.round((progress.merged / progress.total) * 100);
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <div
        role="progressbar"
        aria-label="Merged jobs"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.merged}
        className="h-2 w-32 overflow-hidden rounded bg-muted"
      >
        <div className="h-full bg-success" style={{ width: `${pct}%` }} />
      </div>
      <span>
        {progress.merged}/{progress.total} merged
      </span>
    </div>
  );
}

export function ReadyToCloseBadge({ feature }: { feature: Feature }) {
  if (!feature.progress.readyToClose) return null;
  return <Badge variant="success">Ready to close</Badge>;
}
