import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export const ICON_SIZES = [14, 16, 20] as const;
export type IconSize = (typeof ICON_SIZES)[number];

/**
 * The only place the app renders lucide icons. Sizes are fixed (14/16/20); an icon is decorative
 * (aria-hidden) unless it has a `label`, which makes it an image with that accessible name.
 */
export function Icon({
  icon: Glyph,
  size = 16,
  label,
  className,
}: {
  icon: LucideIcon;
  size?: IconSize;
  label?: string;
  className?: string;
}) {
  return (
    <Glyph
      width={size}
      height={size}
      strokeWidth={2}
      className={cn('shrink-0', className)}
      focusable="false"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  );
}
