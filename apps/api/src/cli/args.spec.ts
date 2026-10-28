import { parseApiKeyCreateArgs, parseMarkBotArgs, parseUserCreateArgs } from './args.js';

describe('parseUserCreateArgs', () => {
  it('reads email and name', () => {
    expect(parseUserCreateArgs(['--email', 'a@b.nl', '--name', 'Ada'])).toEqual({ email: 'a@b.nl', name: 'Ada', bot: false });
  });

  it('reads --bot', () => {
    expect(parseUserCreateArgs(['--email', 'a@b.nl', '--name', 'Bot', '--bot'])).toMatchObject({ bot: true });
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

describe('parseMarkBotArgs', () => {
  it('reads the email', () => {
    expect(parseMarkBotArgs(['--email', 'a@b.nl'])).toEqual({ email: 'a@b.nl' });
  });

  it('requires it', () => {
    expect(() => parseMarkBotArgs([])).toThrow(/user:mark-bot/);
  });
});
