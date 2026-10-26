import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function EmptyState({
  title,
  text,
  action,
  className,
}: {
  title: string;
  text?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center', className)}>
      <h3 className="font-serif text-base font-semibold">{title}</h3>
      {text && <p className="max-w-prose text-sm text-muted-foreground">{text}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
