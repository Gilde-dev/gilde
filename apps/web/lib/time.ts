const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

/** Compact age such as "5m", "3h", "2d", "4mo". */
export function shortAge(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  const units: [string, number][] = [['y', 365 * 24 * 3600], ['mo', 30 * 24 * 3600], ['d', 24 * 3600], ['h', 3600], ['m', 60]];
  for (const [unit, size] of units) if (seconds >= size) return `${Math.floor(seconds / size)}${unit}`;
  return 'now';
}
