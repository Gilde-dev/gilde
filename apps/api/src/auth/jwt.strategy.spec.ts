import { JwtStrategy } from './jwt.strategy.js';

describe('JwtStrategy', () => {
  it('marks JWT provenance and ignores credential claims in the payload', () => {
    process.env.JWT_SECRET ??= 'x'.repeat(40);
    const user = new JwtStrategy().validate({ sub: 'u', email: 'a@b.nl', name: 'A', credential: 'api_key' } as never);
    expect(user).toEqual({ id: 'u', email: 'a@b.nl', name: 'A', credential: 'jwt' });
  });
});
