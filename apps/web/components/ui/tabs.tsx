'use client';

import { createContext, useContext, useId, useState, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface TabsContext {
  value: string;
  select: (value: string) => void;
  base: string;
}
const Ctx = createContext<TabsContext | null>(null);
const useTabs = () => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('Tabs parts must be inside <Tabs>');
  return ctx;
};

/** Accessible tabs (roving tabindex, arrow keys), uncontrolled unless `value` is passed. */
export function Tabs({
  defaultValue,
  value,
  onValueChange,
  className,
  children,
}: {
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  children: ReactNode;
}) {
  const [inner, setInner] = useState(defaultValue ?? '');
  const base = useId();
  const current = value ?? inner;
  const select = (v: string) => {
    setInner(v);
    onValueChange?.(v);
  };
  return (
    <Ctx.Provider value={{ value: current, select, base }}>
      <div className={className}>{children}</div>
    </Ctx.Provider>
  );
}

export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault();
    tabs[next]?.focus();
    tabs[next]?.click();
  };
  return (
    <div
      role="tablist"
      onKeyDown={onKeyDown}
      className={cn('flex gap-1 border-b border-border', className)}
      {...props}
    />
  );
}

export function TabsTrigger({ value, className, children }: { value: string; className?: string; children: ReactNode }) {
  const { value: current, select, base } = useTabs();
  const active = current === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${base}-tab-${value}`}
      aria-selected={active}
      aria-controls={`${base}-panel-${value}`}
      tabIndex={active ? 0 : -1}
      onClick={() => select(value)}
      className={cn(
        '-mb-px border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'border-accent text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TabsContent({ value, className, children }: { value: string; className?: string; children: ReactNode }) {
  const { value: current, base } = useTabs();
  if (current !== value) return null;
  return (
    <div role="tabpanel" id={`${base}-panel-${value}`} aria-labelledby={`${base}-tab-${value}`} className={className}>
      {children}
    </div>
  );
}
