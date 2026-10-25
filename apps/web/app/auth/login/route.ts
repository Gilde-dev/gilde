import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, apiBaseUrl, sessionCookieOptions } from '@/lib/auth';

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: 'Invalid request body' }, { status: 400 });
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ message: 'Could not reach the Gilde API' }, { status: 502 });
  }
  const data = (await upstream.json().catch(() => null)) as {
    accessToken?: string;
    expiresIn?: number;
    user?: unknown;
    message?: unknown;
  } | null;
  if (!upstream.ok || !data?.accessToken) {
    const message = typeof data?.message === 'string' ? data.message : 'Login failed';
    return NextResponse.json({ message }, { status: upstream.ok ? 502 : upstream.status });
  }
  // The token only goes into the cookie, never into the response body.
  const res = NextResponse.json({ user: data.user ?? null });
  res.cookies.set(SESSION_COOKIE, data.accessToken, {
    ...sessionCookieOptions(req.nextUrl.hostname),
    maxAge: data.expiresIn,
  });
  return res;
}
