'use client';

import { useState, type FormEvent } from 'react';
import { api, type CreatedApiKey } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { SidebarNav } from './sidebar-nav';
import { Button } from './ui/button';

const INPUT = 'h-9 rounded-md border border-input bg-card px-2 text-sm';
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export function ApiKeysView() {
  const keys = usePolling(api.listApiKeys, 60_000);
  const [name, setName] = useState('');
  const [days, setDays] = useState('');
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      await keys.refresh();
      setBusy(false);
    }
  }

  const create = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const expiresInDays = days.trim() ? Number(days) : undefined;
      setCreated(await api.createApiKey({ name: name.trim(), ...(expiresInDays ? { expiresInDays } : {}) }));
      setCopied(false);
      setName('');
      setDays('');
    });
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
    } catch {
      setError('Could not copy; select the key and copy it manually.');
    }
  };

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col gap-4 border-r border-border bg-muted/40 p-4">
        <h1 className="text-lg font-bold">Gilde</h1>
        <SidebarNav current="/settings/api-keys" />
      </aside>
      <main className="min-w-0 flex-1">
        <header className="border-b border-border px-4 py-3">
          <h2 className="font-serif text-lg font-semibold">API keys</h2>
          <p className="text-sm text-muted-foreground">
            Long-lived Bearer tokens for scripts and services. A key acts as you.
          </p>
        </header>
        <form onSubmit={create} className="flex flex-wrap items-end gap-2 px-4 pt-4">
          <label className="flex flex-col gap-1 text-sm">
            Name
            <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Expires in (days, optional)
            <input className={INPUT} type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
          <Button type="submit" disabled={busy || !name.trim()}>
            Create key
          </Button>
        </form>
        {error && <p role="alert" className="px-4 pt-3 text-sm text-danger">{error}</p>}
        {created && (
          <section aria-label="New key" className="m-4 rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-warning">
            <p className="font-medium">Copy this key now. It is shown only once and cannot be retrieved later.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-background px-2 py-1">{created.key}</code>
              <Button size="sm" variant="outline" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
                Done
              </Button>
            </div>
          </section>
        )}
        {keys.loading && !keys.data && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
        {keys.error && <p role="alert" className="px-4 pt-3 text-sm text-danger">{keys.error.message}</p>}
        {keys.data && keys.data.length === 0 && <p className="p-4 text-sm text-muted-foreground">No API keys yet.</p>}
        {keys.data && keys.data.length > 0 && (
          <table className="m-4 w-[calc(100%-2rem)] text-left text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">Name</th>
                <th className="py-1 font-medium">Prefix</th>
                <th className="py-1 font-medium">Created</th>
                <th className="py-1 font-medium">Last used</th>
                <th className="py-1 font-medium">Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data.map((k) => (
                <tr key={k.id} className="border-t border-border">
                  <td className="py-2">{k.name}</td>
                  <td className="py-2 font-mono">gk_{k.prefix}</td>
                  <td className="py-2">{formatDate(k.createdAt)}</td>
                  <td className="py-2">{formatDate(k.lastUsedAt)}</td>
                  <td className="py-2">{formatDate(k.expiresAt)}</td>
                  <td className="py-2 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      aria-label={`Revoke ${k.name}`}
                      onClick={() => run(() => api.revokeApiKey(k.id))}
                    >
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}
