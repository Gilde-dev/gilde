import type { ChannelsConfig, NotificationsConfig } from '../config.js';
import { notification } from './fixtures.js';
import { selectOutbound, type OutboundEntry } from './outbound-adapters.js';
import type { OutboundAdapter } from './types.js';

const notifications: NotificationsConfig = {
  kinds: ['job.parked'],
  slack: { botToken: 'xoxb-1', channelId: 'C1' },
  publicUrl: 'https://g',
  pollIntervalMs: 1000,
  batchSize: 5,
  requestTimeoutMs: 1000,
  retryBaseMs: 1000,
  retryMaxMs: 10_000,
};
const base: ChannelsConfig = { apiUrl: 'http://api', apiKey: 'gk_x' };

describe('selectOutbound', () => {
  it('selects nothing when notifications are disabled', () => {
    expect(selectOutbound(base)).toEqual([]);
  });

  it('creates the Slack adapter by default', () => {
    expect(selectOutbound({ ...base, notifications }).map((a) => a.name)).toEqual(['slack']);
  });

  it('supports a second platform without changing the neutral events', async () => {
    const sent: string[] = [];
    const teams: OutboundAdapter = { name: 'teams', send: async (n) => void sent.push(`${n.kind}:${n.title}`) };
    const entries: OutboundEntry[] = [{ name: 'teams', create: () => teams }];
    const [adapter] = selectOutbound({ ...base, notifications }, entries);
    await adapter!.send(notification({ kind: 'job.parked' }), { publicUrl: 'https://g' });
    expect(sent).toEqual(['job.parked:Add thing']);
  });
});
