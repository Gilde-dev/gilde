import { describe, expect, it } from 'vitest';
import { safeNext, sessionCookieOptions } from './auth';

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
