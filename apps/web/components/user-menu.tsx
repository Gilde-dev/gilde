'use client';

import { LogOut, Moon, Sun, SunMoon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { applyThemeChoice, readThemeChoice, type ThemeChoice } from '@/lib/theme';
import { usePolling } from '@/lib/use-polling';
import { cn } from '@/lib/utils';
import { Avatar } from './ui/avatar';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Select } from './ui/select';

const fetchMe = () => api.me();

const THEME_ICON = { light: Sun, dark: Moon, system: SunMoon } as const;

/** Avatar, name and email, plus the theme choice and log out. `compact` is the icon rail: avatar and icon controls only. */
export function UserMenu({ compact = false }: { compact?: boolean }) {
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
  const themeOptions = (
    <>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
      <option value="system">System</option>
    </>
  );
  const name = me.data?.name ?? '';

  if (compact) {
    return (
      <div className="flex flex-col items-center gap-2 border-t border-border pt-3">
        <span title={me.data ? `${name} · ${me.data.email}` : undefined}>
          <Avatar name={me.data?.name} size={32} />
        </span>
        <span
          title="Theme"
          className="relative flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-within:ring-2 focus-within:ring-ring"
        >
          <Icon icon={THEME_ICON[theme]} />
          <select
            aria-label="Theme"
            className="absolute inset-0 size-full cursor-pointer opacity-0"
            value={theme}
            onChange={(e) => choose(e.target.value as ThemeChoice)}
          >
            {themeOptions}
          </select>
        </span>
        <Button variant="ghost" size="sm" aria-label="Log out" title="Log out" icon={LogOut} className="w-8 px-0" onClick={logout} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <Avatar name={me.data?.name} size={32} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={name}>
            {name}
          </p>
          <p className={cn('truncate text-label text-muted-foreground')} title={me.data?.email}>
            {me.data?.email ?? ''}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Select aria-label="Theme" id="theme-choice" className="h-8 min-w-0 flex-1" value={theme} onChange={(e) => choose(e.target.value as ThemeChoice)}>
          {themeOptions}
        </Select>
        <Button variant="outline" size="sm" icon={LogOut} onClick={logout}>
          Log out
        </Button>
      </div>
    </div>
  );
}
