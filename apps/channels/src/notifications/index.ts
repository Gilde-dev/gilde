import type { ChannelsConfig } from '../config.js';
import { createNotificationApi } from './api-client.js';
import { selectOutbound } from './outbound-adapters.js';
import { NotificationWorker } from './worker.js';

/**
 * Builds the notification worker, or returns undefined when notifications are disabled. It needs no co-pilot
 * agent and no Socket Mode connection, so it starts before and independently of the chat adapters.
 */
export function createNotificationWorker(config: ChannelsConfig): NotificationWorker | undefined {
  const notifications = config.notifications;
  if (!notifications) return undefined;
  const [adapter] = selectOutbound(config);
  if (!adapter) return undefined;
  return new NotificationWorker({
    api: createNotificationApi({ apiUrl: config.apiUrl, apiKey: config.apiKey, timeoutMs: notifications.requestTimeoutMs }),
    adapter,
    config: notifications,
    secrets: [config.apiKey, notifications.slack.botToken, config.slack?.appToken ?? ''],
  });
}
