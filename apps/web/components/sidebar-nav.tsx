import Link from 'next/link';

const LINKS = [
  { href: '/', label: 'Board' },
  { href: '/features', label: 'Features' },
  { href: '/metrics', label: 'Metrics' },
  { href: '/lessons', label: 'Lessons' },
  { href: '/skills', label: 'Skills' },
];

export function SidebarNav({ current }: { current: '/' | '/features' | '/metrics' | '/lessons' | '/skills' }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-1 text-sm">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={l.href === current ? 'page' : undefined}
          className={l.href === current ? 'rounded-md bg-muted px-2 py-1 font-medium' : 'rounded-md px-2 py-1 text-muted-foreground hover:bg-muted'}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
