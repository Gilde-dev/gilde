import { loadConfig } from './config.js';

const KEY = 'gk_12345678_secret-value';

describe('loadConfig', () => {
  it('requires GILDE_API_KEY', () => {
    expect(() => loadConfig({})).toThrow(/GILDE_API_KEY is required/);
    expect(() => loadConfig({ GILDE_API_KEY: '' })).toThrow(/GILDE_API_KEY is required/);
  });

  it('defaults the API url and works without Slack', () => {
    expect(loadConfig({ GILDE_API_KEY: KEY })).toEqual({ apiUrl: 'http://localhost:4100/api', apiKey: KEY, slack: undefined });
  });

  it('trims a trailing slash from the API url', () => {
    expect(loadConfig({ GILDE_API_KEY: KEY, GILDE_API_URL: 'https://gilde.example.com/api/' }).apiUrl).toBe('https://gilde.example.com/api');
  });

  it('rejects an invalid API url', () => {
    expect(() => loadConfig({ GILDE_API_KEY: KEY, GILDE_API_URL: 'nope' })).toThrow(/GILDE_API_URL/);
  });

  it('reads both Slack tokens', () => {
    expect(loadConfig({ GILDE_API_KEY: KEY, SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1' }).slack).toEqual({ botToken: 'xoxb-1', appToken: 'xapp-1' });
  });

  it.each([
    [{ SLACK_BOT_TOKEN: 'xoxb-1' }, 'SLACK_APP_TOKEN'],
    [{ SLACK_APP_TOKEN: 'xapp-1' }, 'SLACK_BOT_TOKEN'],
  ])('rejects partial Slack config with a clear message', (slackEnv, missing) => {
    expect(() => loadConfig({ GILDE_API_KEY: KEY, ...slackEnv })).toThrow(new RegExp(`${missing}: Slack needs both SLACK_BOT_TOKEN and SLACK_APP_TOKEN`));
  });

  it('treats empty Slack variables as unset', () => {
    expect(loadConfig({ GILDE_API_KEY: KEY, SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '' }).slack).toBeUndefined();
  });

  it('never puts secret values in the error message', () => {
    let message = '';
    try {
      loadConfig({ GILDE_API_KEY: KEY, SLACK_BOT_TOKEN: 'xoxb-secret' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('xoxb-secret');
    expect(message).not.toContain(KEY);
  });
});
