import type { SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { controlClass } from './input';

/** Native select, styled. */
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(controlClass, 'pr-8', className)} {...props} />;
}
