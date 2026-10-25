import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, apiBaseUrl, sessionCookieOptions } from '@/lib/auth';

const CONVERSATION_TOO_LONG = 'The conversation is too long; start a new conversation.';

type Ctx = { params: Promise<{ path: string[] }> };

async function forward(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { path } = await ctx.params;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const headers: Record<string, string> = { Accept: req.headers.get('accept') ?? 'application/json' };
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

  // A request body over the API's co-pilot limit: say what to do instead of showing the raw error.
  if (upstream.status === 413 && path.slice(0, 2).join('/') === 'v1/mastra') {
    return NextResponse.json({ message: CONVERSATION_TOO_LONG }, { status: 413 });
  }

  // Pass the body through as a stream so chat responses (text/event-stream) reach the browser as they are produced.
  const responseType = upstream.headers.get('content-type') ?? 'application/json';
  const responseHeaders: Record<string, string> = { 'Content-Type': responseType };
  if (responseType.includes('text/event-stream')) {
    responseHeaders['Cache-Control'] = 'no-cache, no-transform';
    responseHeaders['X-Accel-Buffering'] = 'no';
  }
  const res = new NextResponse(upstream.status === 204 ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
  if (upstream.status === 401) {
    res.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(req.nextUrl.hostname), maxAge: 0 });
  }
  return res;
}

export { forward as GET, forward as POST, forward as PATCH, forward as PUT, forward as DELETE };
