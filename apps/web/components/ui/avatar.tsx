import { Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

const SIZES = {
  20: { box: 'size-5 text-[9px]', icon: 14 },
  24: { box: 'size-6 text-[10px]', icon: 14 },
  32: { box: 'size-8 text-label', icon: 16 },
} as const;
export type AvatarSize = keyof typeof SIZES;

/** Up to two initials from a name or email: "Ada Lovelace" -> "AL", "ada@x.io" -> "AD". */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._@-]+/).filter(Boolean);
  if (words.length === 0) return '';
  const letters = words.length === 1 ? words[0]!.slice(0, 2) : words[0]![0]! + words[1]![0]!;
  return letters.toUpperCase();
}

/** Initials on a neutral surface. Without a name it shows the system (bot) fallback. */
export function Avatar({ name, size = 24, className }: { name?: string | null; size?: AvatarSize; className?: string }) {
  const s = SIZES[size];
  const text = name ? initials(name) : '';
  return (
    <span
      role="img"
      aria-label={name && text ? name : 'System'}
      data-size={size}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full border border-border-subtle bg-muted font-medium text-muted-foreground',
        s.box,
        className,
      )}
    >
      {text ? <span aria-hidden="true">{text}</span> : <Icon icon={Bot} size={s.icon} />}
    </span>
  );
}
