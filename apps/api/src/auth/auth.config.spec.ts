import { assertAuthConfig, authEnabled, jwtExpiresIn, jwtSecret } from './auth.config.js';

describe('auth config', () => {
  it('is enabled unless AUTH_ENABLED=false', () => {
    expect(authEnabled({})).toBe(true);
    expect(authEnabled({ AUTH_ENABLED: 'true' })).toBe(true);
    expect(authEnabled({ AUTH_ENABLED: 'false' })).toBe(false);
  });

  it('refuses a missing or short JWT_SECRET when enabled', () => {
    expect(() => assertAuthConfig({})).toThrow(/JWT_SECRET/);
    expect(() => assertAuthConfig({ JWT_SECRET: 'short' })).toThrow(/at least 32/);
    expect(() => assertAuthConfig({ JWT_SECRET: 'x'.repeat(32) })).not.toThrow();
  });

  it('does not need a JWT_SECRET when disabled', () => {
    expect(() => assertAuthConfig({ AUTH_ENABLED: 'false' })).not.toThrow();
    expect(jwtSecret({ AUTH_ENABLED: 'false' }).length).toBeGreaterThanOrEqual(32);
  });

  it('defaults the expiry to 12h', () => {
    expect(jwtExpiresIn({})).toBe('12h');
    expect(jwtExpiresIn({ JWT_EXPIRES_IN: '30m' })).toBe('30m');
  });
});
