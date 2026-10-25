import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { middleware } from './middleware';

const req = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, cookie ? { headers: { cookie: `gilde_session=${cookie}` } } : {});

describe('middleware', () => {
  it('redirects to /login with next when there is no cookie', () => {
    const res = middleware(req('/features?x=1'));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('next')).toBe('/features?x=1');
  });

  it('lets /login through without a cookie', () => {
    expect(middleware(req('/login')).headers.get('location')).toBeNull();
  });

  it('sends a logged-in user from /login to /', () => {
    const res = middleware(req('/login', 't'));
    expect(new URL(res.headers.get('location')!).pathname).toBe('/');
  });

  it('lets requests with a cookie through', () => {
    expect(middleware(req('/metrics', 't')).headers.get('location')).toBeNull();
  });

  it('answers 401 for proxy calls without a cookie', () => {
    expect(middleware(req('/api/gilde/v1/jobs')).status).toBe(401);
  });
});
