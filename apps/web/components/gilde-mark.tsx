import { cn } from '@/lib/utils';

/** The Gilde mark: a stepped-gable guild house with the door and window as holes, on a 64×64 grid. */
export const GILDE_MARK_PATH =
  'M8 58V30h6v-8h6v-8h6V6h12v8h6v8h6v8h6v28z' + // gable
  'M28 58V47.5a4 4 0 0 1 8 0V58z' + // door
  'M29 32a3 3 0 1 0 6 0a3 3 0 1 0 -6 0z'; // window

/**
 * The gable in the current text colour, so it follows the theme tokens (e.g. `text-primary-foreground`).
 * Decorative: the surrounding link or heading carries the name.
 */
export function GildeMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={cn('shrink-0', className)}
    >
      <path fill="currentColor" fillRule="evenodd" d={GILDE_MARK_PATH} />
    </svg>
  );
}

/** The app-icon form of the mark: a white gable on the brand gradient in a rounded square. */
export function GildeLogoTile({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center rounded-md bg-primary-gradient text-primary-foreground', className)}
      style={{ width: size, height: size }}
    >
      <GildeMark size={Math.round(size * 0.66)} />
    </span>
  );
}
