import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, apiBaseUrl, sessionCookieOptions } from '@/lib/auth';

type Ctx = { params: Promise<{ path: string[] }> };

async function forward(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { path } = await ctx.params;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const contentType = req.headers.get('content-type');
  if (contentType) headers['Content-Type'] = contentType;
  const hasBody = req.method !== 'GET' && req.method !== 'DELETE';
  const text = hasBody ? await req.text() : '';

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`, {
      method: req.method,
      headers,
      cache: 'no-store',
      ...(text ? { body: text } : {}),
    });
  } catch {
    return NextResponse.json({ message: 'Could not reach the Gilde API' }, { status: 502 });
  }

  const res = new NextResponse(upstream.status === 204 ? null : await upstream.text(), {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' },
  });
  if (upstream.status === 401) {
    res.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(req.nextUrl.hostname), maxAge: 0 });
  }
  return res;
}

export { forward as GET, forward as POST, forward as PATCH, forward as PUT, forward as DELETE };
