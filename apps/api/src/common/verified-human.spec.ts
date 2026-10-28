import { ForbiddenException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.dto.js';

import { requireVerifiedHuman } from './verified-human.js';

const id = '11111111-1111-4111-8111-111111111111';
const jwt: AuthUser = { id, name: 'Ada', email: 'ada@example.com', credential: 'jwt' };
const human = { id, email: 'ada@example.com', isBot: false };

describe('requireVerifiedHuman', () => {
  it('accepts a persisted non-bot JWT human', () => {
    expect(requireVerifiedHuman(jwt, human, undefined)).toEqual(human);
  });

  it('rejects a missing user, e.g. when auth is disabled', () => {
    expect(() => requireVerifiedHuman(undefined, null, undefined)).toThrow(ForbiddenException);
  });

  it('rejects API keys, also of a human account', () => {
    expect(() => requireVerifiedHuman({ ...jwt, credential: 'api_key' }, human, undefined)).toThrow(ForbiddenException);
  });

  it('rejects a user without provenance', () => {
    expect(() => requireVerifiedHuman({ ...jwt, credential: undefined }, human, undefined)).toThrow(ForbiddenException);
  });

  it('rejects a deleted or mismatching identity', () => {
    expect(() => requireVerifiedHuman(jwt, null, undefined)).toThrow(ForbiddenException);
    expect(() => requireVerifiedHuman(jwt, { ...human, id: '22222222-2222-4222-8222-222222222222' }, undefined)).toThrow(ForbiddenException);
  });

  it('rejects bots, however the token claims it', () => {
    expect(() => requireVerifiedHuman({ ...jwt, isBot: false } as AuthUser, { ...human, isBot: true }, undefined)).toThrow(ForbiddenException);
  });

  it('rejects the scout account case-insensitively, even when unmarked', () => {
    expect(() => requireVerifiedHuman(jwt, human, ' ADA@example.com ')).toThrow(ForbiddenException);
    expect(requireVerifiedHuman(jwt, human, 'other@example.com')).toEqual(human);
  });
});
