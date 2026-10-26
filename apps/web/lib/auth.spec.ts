import { afterEach, describe, expect, it, vi } from 'vitest';
import { forwardedForHeader, safeNext, sessionCookieOptions } from './auth';

describe('safeNext', () => {
  it('keeps relative paths', () => expect(safeNext('/features?a=1')).toBe('/features?a=1'));
  it.each([null, '', 'https://evil.example', '//evil.example', '/\\evil.example', 'features'])('rejects %s', (v) =>
    expect(safeNext(v)).toBe('/'),
  );
});

describe('sessionCookieOptions', () => {
  it('is Secure except on localhost', () => {
    expect(sessionCookieOptions('localhost')).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: false, path: '/' });
    expect(sessionCookieOptions('gilde.example').secure).toBe(true);
  });
});

describe('sessionCookieOptions in production', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('is Secure even on localhost', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(sessionCookieOptions('localhost').secure).toBe(true);
  });
});

describe('forwardedForHeader', () => {
  it('passes X-Forwarded-For on unchanged', () =>
    expect(forwardedForHeader({ headers: new Headers({ 'x-forwarded-for': '203.0.113.7' }) })).toEqual({ 'X-Forwarded-For': '203.0.113.7' }));
  it('adds nothing without it', () => expect(forwardedForHeader({ headers: new Headers() })).toEqual({}));
});
