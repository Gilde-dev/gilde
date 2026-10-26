import { cloneElement, useId, type ReactElement } from 'react';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Label } from './label';

/** Messages of the zod issue(s) whose path starts with `path`. */
export function issueMessages(error: unknown, path: string): string[] {
  if (!(error instanceof ApiError)) return [];
  return error.issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`)).map((i) => i.message);
}

/**
 * Label + control + hint + error text. Pass `error` (an ApiError from lib/api.ts) with `path` to show the zod
 * issue for that field, or `message` for an error you already have.
 */
export function Field({
  label,
  path,
  error,
  message,
  hint,
  className,
  children,
}: {
  label: string;
  path?: string;
  error?: unknown;
  message?: string;
  hint?: string;
  className?: string;
  children: ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>;
}) {
  const id = useId();
  const messages = message ? [message] : path ? issueMessages(error, path) : [];
  const describedBy = [hint && `${id}-hint`, messages.length > 0 && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Label htmlFor={id}>{label}</Label>
      {cloneElement(children, { id, 'aria-invalid': messages.length > 0 || undefined, 'aria-describedby': describedBy })}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {messages.length > 0 && (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {messages.join(', ')}
        </p>
      )}
    </div>
  );
}
