'use client';

import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { safeNext } from '@/lib/auth';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { GildeLogoTile } from './gilde-mark';

export function LoginForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        window.location.assign(safeNext(params.get('next')));
        return;
      }
      if (res.status === 429) setError('Too many attempts, try again in a minute');
      else if (res.status === 401) setError('Invalid email or password');
      else {
        const json = (await res.json().catch(() => null)) as { message?: unknown } | null;
        setError(typeof json?.message === 'string' ? json.message : 'Login failed');
      }
    } catch {
      setError('Could not reach the server');
    }
    setLoading(false);
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="flex items-center gap-3 text-display-sm font-semibold tracking-tight">
          <GildeLogoTile size={40} />
          Gilde
        </h1>
        <label className="flex flex-col gap-1 text-sm">
          Email
          <Input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <Input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" disabled={loading}>
          {loading ? 'Logging in…' : 'Log in'}
        </Button>
      </form>
    </main>
  );
}
