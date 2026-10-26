import { cva, type VariantProps } from 'class-variance-authority';
import type { LucideIcon } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

export const badgeVariants = cva('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-label', {
  variants: {
    variant: {
      neutral: 'bg-muted text-muted-foreground',
      accent: 'bg-accent-soft text-accent',
      success: 'bg-success-soft text-success',
      warning: 'bg-warning-soft text-warning',
      danger: 'bg-danger-soft text-danger',
      info: 'bg-info-soft text-info',
      running: 'bg-running-soft text-running',
      pr: 'bg-pr-soft text-pr',
    },
  },
  defaultVariants: { variant: 'neutral' },
});

const DOT: Record<BadgeVariant, string> = {
  neutral: 'bg-muted-foreground',
  accent: 'bg-accent',
  success: 'bg-success-solid',
  warning: 'bg-warning-solid',
  danger: 'bg-danger-solid',
  info: 'bg-info-solid',
  running: 'bg-running-solid',
  pr: 'bg-pr-solid',
};

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  /** Small coloured dot before the text. Ignored when `icon` is set. */
  dot?: boolean;
  icon?: LucideIcon;
}

export function Badge({ className, variant, dot, icon, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {icon ? (
        <Icon icon={icon} size={14} />
      ) : dot ? (
        <span data-badge-dot aria-hidden="true" className={cn('size-1.5 rounded-full', DOT[variant ?? 'neutral'])} />
      ) : null}
      {children}
    </span>
  );
}
