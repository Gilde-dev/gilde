'use client';

import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { GildeLogoTile } from './gilde-mark';

const MIN_PASSWORD_LENGTH = 12;
const INVALID_LINK = 'This setup link is invalid or has expired. Ask an admin for a new link.';

export function SetupForm() {
  const token = useSearchParams().get('token');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) return setError(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
    if (password !== again) return setError('The passwords do not match');
    setLoading(true);
    try {
      const res = await fetch('/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) {
        window.location.assign('/');
        return;
      }
      setError(res.status === 429 ? 'Too many attempts, try again in a minute' : INVALID_LINK);
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
          Set your password
        </h1>
        {!token ? (
          <p role="alert" className="text-sm text-danger">
            {INVALID_LINK}
          </p>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-sm">
              New password
              <Input type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Repeat password
              <Input type="password" required autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
            </label>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <Button type="submit" disabled={loading}>
              {loading ? 'Saving…' : 'Set password and log in'}
            </Button>
          </>
        )}
      </form>
    </main>
  );
}
