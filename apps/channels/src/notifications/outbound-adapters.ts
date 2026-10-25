import type { ChannelsConfig, NotificationsConfig } from '../config.js';
import { createSlackSender } from './slack-sender.js';
import type { OutboundAdapter } from './types.js';

export interface OutboundEntry {
  name: string;
  /** Returns the adapter when the platform is configured for notifications, otherwise undefined. */
  create(config: NotificationsConfig): OutboundAdapter | undefined;
}

/** Outbound counterpart of `ADAPTER_ENTRIES` (conversational); add Teams or others here. */
export const OUTBOUND_ENTRIES: OutboundEntry[] = [
  {
    name: 'slack',
    create: (config) => createSlackSender({ botToken: config.slack.botToken, channelId: config.slack.channelId, timeoutMs: config.requestTimeoutMs }),
  },
];

export function selectOutbound(config: ChannelsConfig, entries: OutboundEntry[] = OUTBOUND_ENTRIES): OutboundAdapter[] {
  const notifications = config.notifications;
  if (!notifications) return [];
  return entries.flatMap((entry) => {
    const adapter = entry.create(notifications);
    return adapter ? [adapter] : [];
  });
}
