import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Card } from './card';

/** A label with a big number. `delta` and `hint` are optional; pass only real data. */
export function StatCard({
  label,
  value,
  delta,
  hint,
  className,
}: {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('flex flex-col gap-1 p-4', className)}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="flex items-baseline gap-2">
        <p className="text-display-sm tabular-nums">{value}</p>
        {delta && <p className="text-sm font-medium text-muted-foreground">{delta}</p>}
      </div>
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </Card>
  );
}
