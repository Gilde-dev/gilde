import { parseApiKeyCreateArgs, parseUserCreateArgs } from './args.js';

describe('parseUserCreateArgs', () => {
  it('reads email and name', () => {
    expect(parseUserCreateArgs(['--email', 'a@b.nl', '--name', 'Ada'])).toEqual({ email: 'a@b.nl', name: 'Ada' });
  });

  it('requires both', () => {
    expect(() => parseUserCreateArgs(['--email', 'a@b.nl'])).toThrow(/Usage/);
  });
});

describe('parseApiKeyCreateArgs', () => {
  it('reads email and name', () => {
    expect(parseApiKeyCreateArgs(['--email', 'a@b.nl', '--name', 'bot'])).toEqual({ email: 'a@b.nl', name: 'bot' });
  });

  it('requires both', () => {
    expect(() => parseApiKeyCreateArgs(['--name', 'bot'])).toThrow(/apikey:create/);
  });
});
