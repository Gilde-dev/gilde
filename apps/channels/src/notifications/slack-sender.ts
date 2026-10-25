import { errorMessage } from './sanitize.js';
import { formatSlack } from './format-slack.js';
import { NotifyError, type GildeNotification, type OutboundAdapter, type OutboundContext } from './types.js';

const SLACK_POST_URL = 'https://slack.com/api/chat.postMessage';

/** Errors that will not fix themselves: credentials, scopes, or a channel the bot cannot post to. */
const PERMANENT_SLACK_ERRORS = new Set([
  'invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'missing_scope', 'no_permission',
  'channel_not_found', 'not_in_channel', 'is_archived', 'restricted_action', 'invalid_arguments', 'msg_too_long', 'org_login_required',
]);

export interface SlackSenderOptions {
  botToken: string;
  channelId: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * Posts with the Slack Web API over built-in fetch. CopilotKit Channels only exposes conversational
 * adapters (event in, thread reply out) and no way to post to a channel without an incoming event,
 * so proactive posts do not go through it; this keeps Slack HTTP in apps/channels all the same.
 */
export function createSlackSender(options: SlackSenderOptions): OutboundAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    name: 'slack',
    async send(notification: GildeNotification, context: OutboundContext): Promise<void> {
      let response: Response;
      try {
        response = await doFetch(SLACK_POST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${options.botToken}` },
          body: JSON.stringify({
            channel: options.channelId,
            text: formatSlack(notification, context),
            link_names: false,
            unfurl_links: false,
            unfurl_media: false,
          }),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        throw new NotifyError(`Slack request failed: ${errorMessage(error, [options.botToken])}`, false);
      }

      if (response.status === 429) {
        const seconds = Number(response.headers.get('Retry-After'));
        throw new NotifyError('Slack rate limited the request', false, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined);
      }
      if (response.status === 401 || response.status === 403) throw new NotifyError(`Slack rejected the credentials (HTTP ${response.status})`, true);
      if (!response.ok) throw new NotifyError(`Slack answered HTTP ${response.status}`, false);

      const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (body?.ok) return;
      const code = typeof body?.error === 'string' ? body.error.replace(/[^a-z_]/g, '').slice(0, 60) : 'unknown_error';
      throw new NotifyError(`Slack error: ${code}`, PERMANENT_SLACK_ERRORS.has(code));
    },
  };
}
