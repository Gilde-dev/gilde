import type { TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { controlClass } from './input';

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(controlClass, 'h-auto min-h-20 py-2', className)} {...props} />;
}
