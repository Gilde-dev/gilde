import { cva, type VariantProps } from 'class-variance-authority';
import type { LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-primary-gradient text-primary-foreground shadow-sm hover:brightness-95',
        secondary: 'bg-muted text-foreground hover:bg-muted/70',
        outline: 'border border-input bg-card hover:bg-muted',
        ghost: 'hover:bg-muted',
        danger: 'bg-danger text-danger-foreground hover:bg-danger/90',
      },
      size: { md: 'h-9 px-4', sm: 'h-8 px-3' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Optional icon (decorative; the button text names it). */
  icon?: LucideIcon;
  iconPosition?: 'start' | 'end';
}

export function Button({ className, variant, size, icon, iconPosition = 'start', children, ...props }: ButtonProps) {
  const glyph = icon && <Icon icon={icon} size={size === 'sm' ? 14 : 16} />;
  return (
    <button className={cn(buttonVariants({ variant, size }), className)} {...props}>
      {iconPosition === 'start' && glyph}
      {children}
      {iconPosition === 'end' && glyph}
    </button>
  );
}
