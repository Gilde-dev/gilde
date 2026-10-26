import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const controlClass =
  'h-9 w-full rounded-md border border-input bg-card px-3 text-md text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-[invalid=true]:border-danger';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(controlClass, className)} {...props} />;
}
