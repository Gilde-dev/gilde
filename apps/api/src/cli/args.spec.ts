import { parseUserCreateArgs } from './args.js';

describe('parseUserCreateArgs', () => {
  it('reads email and name', () => {
    expect(parseUserCreateArgs(['--email', 'a@b.nl', '--name', 'Ada'])).toEqual({ email: 'a@b.nl', name: 'Ada' });
  });

  it('requires both', () => {
    expect(() => parseUserCreateArgs(['--email', 'a@b.nl'])).toThrow(/Usage/);
  });
});
