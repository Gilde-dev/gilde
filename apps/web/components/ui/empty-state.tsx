import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

export function EmptyState({
  title,
  text,
  action,
  icon,
  className,
}: {
  title: string;
  text?: string;
  action?: ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-2 rounded-xl border border-dashed border-border p-8 text-center', className)}>
      {icon && (
        <span className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon icon={icon} size={20} />
        </span>
      )}
      <h3 className="text-md font-semibold">{title}</h3>
      {text && <p className="max-w-prose text-sm text-muted-foreground">{text}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
