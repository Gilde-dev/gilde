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

describe('loadConfig notifications', () => {
  const slackEnv = { GILDE_API_KEY: KEY, SLACK_BOT_TOKEN: 'xoxb-secret-1', SLACK_APP_TOKEN: 'xapp-secret-1' };
  const enabled = {
    ...slackEnv,
    NOTIFICATIONS_ENABLED: 'true',
    NOTIFICATION_SLACK_CHANNEL_ID: 'C0123ABCDEF',
    GILDE_PUBLIC_URL: 'https://gilde.example.com/',
  };

  it('is disabled by default and without any notification variables', () => {
    expect(loadConfig(slackEnv).notifications).toBeUndefined();
    expect(loadConfig({ ...slackEnv, NOTIFICATIONS_ENABLED: 'false', NOTIFICATION_SLACK_CHANNEL_ID: 'C0123ABCDEF' }).notifications).toBeUndefined();
  });

  it('enables all seven kinds for one channel with bounded defaults and needs no LLM variables', () => {
    const { notifications } = loadConfig(enabled);
    expect(notifications).toMatchObject({
      kinds: ['job.awaiting_review', 'job.parked', 'job.approval_needed', 'revision.waiting', 'feature.ready_to_close', 'budget.soft', 'budget.hard'],
      slack: { botToken: 'xoxb-secret-1', channelId: 'C0123ABCDEF' },
      publicUrl: 'https://gilde.example.com',
      pollIntervalMs: 15_000,
      batchSize: 10,
    });
  });

  it('selects kinds', () => {
    expect(loadConfig({ ...enabled, NOTIFICATION_KINDS: 'job.parked, revision.waiting' }).notifications?.kinds).toEqual(['job.parked', 'revision.waiting']);
    expect(loadConfig({ ...enabled, NOTIFICATION_KINDS: 'budget.soft,budget.hard' }).notifications?.kinds).toEqual(['budget.soft', 'budget.hard']);
  });

  it('rejects unknown kinds, missing settings and out-of-range numbers by name', () => {
    expect(() => loadConfig({ ...enabled, NOTIFICATION_KINDS: 'job.bogus' })).toThrow(/NOTIFICATION_KINDS: unknown kind "job.bogus"/);
    expect(() => loadConfig({ ...slackEnv, NOTIFICATIONS_ENABLED: 'true' })).toThrow(/NOTIFICATION_SLACK_CHANNEL_ID is required[\s\S]*GILDE_PUBLIC_URL is required/);
    expect(() => loadConfig({ ...enabled, NOTIFICATION_BATCH_SIZE: '1000' })).toThrow(/NOTIFICATION_BATCH_SIZE/);
    expect(() => loadConfig({ ...enabled, NOTIFICATION_SLACK_CHANNEL_ID: '#werkplaats' })).toThrow(/NOTIFICATION_SLACK_CHANNEL_ID/);
  });

  it('still validates chat credentials and keeps secrets out of errors', () => {
    expect(() => loadConfig({ GILDE_API_KEY: KEY, SLACK_BOT_TOKEN: 'xoxb-secret-1', NOTIFICATIONS_ENABLED: 'true' })).toThrow(/SLACK_APP_TOKEN/);
    try {
      loadConfig({ ...enabled, NOTIFICATION_POLL_INTERVAL_MS: 'xoxb-secret-1' });
    } catch (error) {
      expect((error as Error).message).not.toContain('secret');
    }
  });
});
