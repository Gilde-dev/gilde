import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as login } from './login/route';
import { POST as logout } from './logout/route';

afterEach(() => vi.unstubAllGlobals());

const post = (path: string, body?: unknown) =>
  new NextRequest(`http://localhost:3000${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

describe('login route', () => {
  it('sets an httpOnly cookie and does not expose the token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ accessToken: 'jwt', expiresIn: 43200, user: { name: 'A' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await login(post('/auth/login', { email: 'a@b.nl', password: 'p' }));
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:4100/api/v1/auth/login');
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toContain('gilde_session=jwt');
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=lax/i);
    expect(set).toMatch(/Max-Age=43200/i);
    expect(set).toMatch(/Path=\//);
    expect(set).not.toMatch(/Secure/i);
    expect(JSON.stringify(await res.json())).not.toContain('jwt');
  });

  it('passes API errors through without a cookie', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"message":"Invalid email or password"}', { status: 401 })));
    const res = await login(post('/auth/login', { email: 'a', password: 'b' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('logout route', () => {
  it('clears the cookie', async () => {
    const res = await logout(post('/auth/logout'));
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
  });
});
