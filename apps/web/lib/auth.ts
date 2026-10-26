export const SESSION_COOKIE = 'gilde_session';

/** Server-only API base URL; the browser only ever talks to /api/gilde. */
export function apiBaseUrl(): string {
  return (process.env.GILDE_API_URL ?? 'http://localhost:4100/api').replace(/\/+$/, '');
}

/** Only same-site relative paths are allowed as a post-login target. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\') || /[\u0000-\u001f]/.test(next)) return '/';
  return next;
}

export function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export function sessionCookieOptions(hostname: string) {
  return { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production' || !isLocalhost(hostname), path: '/' };
}

/** Passes the client address Caddy put in X-Forwarded-For on to the API, so its login throttle sees real client IPs. */
export function forwardedForHeader(req: { headers: Headers }): Record<string, string> {
  const forwardedFor = req.headers.get('x-forwarded-for');
  return forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {};
}
