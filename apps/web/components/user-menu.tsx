'use client';

import Link from 'next/link';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { Button } from './ui/button';

const fetchMe = () => api.me();

export function UserMenu() {
  const me = usePolling(fetchMe, 5 * 60_000);
  const logout = async () => {
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } finally {
      window.location.assign('/login');
    }
  };
  return (
    <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3 text-sm">
      <span className="min-w-0 truncate" title={me.data?.email}>
        {me.data?.name ?? ''}
      </span>
      <Link href="/settings/api-keys" className="text-muted-foreground hover:underline">
        API keys
      </Link>
      <Button variant="ghost" size="sm" onClick={logout}>
        Log out
      </Button>
    </div>
  );
}
