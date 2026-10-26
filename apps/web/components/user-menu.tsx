'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { applyThemeChoice, readThemeChoice, type ThemeChoice } from '@/lib/theme';
import { usePolling } from '@/lib/use-polling';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Select } from './ui/select';

const fetchMe = () => api.me();

export function UserMenu() {
  const me = usePolling(fetchMe, 5 * 60_000);
  const [theme, setTheme] = useState<ThemeChoice>('system');
  useEffect(() => setTheme(readThemeChoice()), []);
  const logout = async () => {
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } finally {
      window.location.assign('/login');
    }
  };
  const choose = (choice: ThemeChoice) => {
    setTheme(choice);
    applyThemeChoice(choice);
  };
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate" title={me.data?.email}>
          {me.data?.name ?? ''}
        </span>
        <Button variant="ghost" size="sm" onClick={logout}>
          Log out
        </Button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="theme-choice">Theme</Label>
        <Select id="theme-choice" className="h-8 w-28" value={theme} onChange={(e) => choose(e.target.value as ThemeChoice)}>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="system">System</option>
        </Select>
      </div>
    </div>
  );
}
