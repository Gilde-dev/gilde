'use client';

import Link from 'next/link';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { UserMenu } from './user-menu';

const fetchProposed = () => api.listRevisions('proposed');

const LINKS = [
  { href: '/', label: 'Board' },
  { href: '/features', label: 'Features' },
  { href: '/metrics', label: 'Metrics' },
  { href: '/proposals', label: 'Proposals' },
  { href: '/lessons', label: 'Lessons' },
  { href: '/skills', label: 'Skills' },
];

export function SidebarNav({
  current,
}: {
  current: '/' | '/features' | '/metrics' | '/proposals' | '/lessons' | '/skills' | '/settings/api-keys';
}) {
  const proposed = usePolling(fetchProposed, 30_000);
  const count = proposed.data?.length ?? 0;
  return (
    <>
      <nav aria-label="Main" className="flex flex-col gap-1 text-sm">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            aria-current={l.href === current ? 'page' : undefined}
            className={
              l.href === current
                ? 'rounded-md bg-muted px-2 py-1 font-medium'
                : 'rounded-md px-2 py-1 text-muted-foreground hover:bg-muted'
            }
          >
            {l.label}
            {l.href === '/proposals' && count > 0 && (
              <span
                aria-label={`${count} pending`}
                className="ml-2 rounded-full bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent"
              >
                {count}
              </span>
            )}
          </Link>
        ))}
      </nav>
      <UserMenu />
    </>
  );
}
