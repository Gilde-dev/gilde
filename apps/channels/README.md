# @gilde/channels

A separate long-running process that runs the Gilde co-pilot in chat platforms with
[CopilotKit Channels](https://docs.copilotkit.ai/channels). It reaches the `gilde` agent of the API
remotely over AG-UI (`MastraClient` + `@ag-ui/mastra`, base URL `${GILDE_API_URL}/v1/mastra`) and
authenticates with the API key of a bot user. For now every chat user is served as that bot user.
The bot user is both the acting user and the memory resource: at startup the process reads its id from
`GET ${GILDE_API_URL}/v1/auth/me` and sends it as the `resourceId`, because the API rejects any other
resource (403). Startup fails with a clear message when the key is invalid (401) or the API is unreachable.

Slack (Socket Mode) is the first platform. An adapter is enabled when its credentials are set;
without any adapter the process logs `No channel adapters configured (set SLACK_BOT_TOKEN and SLACK_APP_TOKEN)`
and exits with code 0. Tokens and keys are never logged.

## Configuration

Copy `.env.example` to `.env`.

| Variable | |
| --- | --- |
| `GILDE_API_URL` | Gilde API, default `http://localhost:4100/api` |
| `GILDE_API_KEY` | Required. API key of the bot user |
| `SLACK_BOT_TOKEN` | `xoxb-…`; needs `SLACK_APP_TOKEN` too |
| `SLACK_APP_TOKEN` | `xapp-…`; needs `SLACK_BOT_TOKEN` too |

Setting only one of the two Slack variables is rejected at startup.

The API needs its co-pilot enabled (`OPENAI_API_KEY`, `COPILOT_MODEL`), see the root `AGENTS.md`.

## Slack notifications (#werkplaats)

The same process can post factory notifications to one Slack channel. It is separate from the chat:
it needs no co-pilot (`OPENAI_API_KEY`, `COPILOT_MODEL`), no LLM and no Socket Mode connection at runtime, and
a chat or Slack failure does not stop it (or the API, dispatcher or webhooks). Messages are formatted
deterministically in this package; the API only stores platform-neutral events (`GET /v1/notifications`).

| Variable | |
| --- | --- |
| `NOTIFICATIONS_ENABLED` | `true` to start the worker. Default off |
| `NOTIFICATION_KINDS` | Comma-separated kinds, default all seven: `job.awaiting_review,job.parked,job.approval_needed,revision.waiting,feature.ready_to_close,budget.soft,budget.hard` |
| `NOTIFICATION_SLACK_CHANNEL_ID` | Required. Slack channel ID (`C…`) of #werkplaats |
| `GILDE_PUBLIC_URL` | Required. Public URL of the web UI, used for deep links |
| `NOTIFICATION_POLL_INTERVAL_MS` | Default 15000 |
| `NOTIFICATION_BATCH_SIZE` | Default 10, max 100 |
| `NOTIFICATION_REQUEST_TIMEOUT_MS` | Default 10000, for every API and Slack request |
| `NOTIFICATION_RETRY_BASE_MS` / `NOTIFICATION_RETRY_MAX_MS` | Backoff base (30000) and cap (3600000) |

Enabling needs `SLACK_BOT_TOKEN` too (and, by the existing rule, `SLACK_APP_TOKEN`). Example for all kinds:

```sh
NOTIFICATIONS_ENABLED=true
NOTIFICATION_SLACK_CHANNEL_ID=<channel ID of #werkplaats>
GILDE_PUBLIC_URL=https://gilde.example.com
```

The channel ID is operator-supplied: in Slack, open the channel details and copy the ID at the bottom.
Invite the bot to the channel (`/invite @<bot name>`) and give it the `chat:write` scope (already in the scopes above).

Budget alerts (`budget.soft`, `budget.hard`) carry no job, PR or repo: one message per scope (global or project), period
(day or ISO week) and kind, for example `Budget Gilde: $8.10 of $10.00 estimated today (81%). Resets 00:00 UTC.`.
They say *estimated*, add a caveat when some usage has no price (the estimate may be too low), explain an invalid
`GLOBAL_*_BUDGET_USD` setting by variable name only, and link to the project's settings page or, for the global budget,
to `/metrics`. The API records each occurrence once per scope, period start and kind in the same outbox as every other
kind (see "Budgets" in the root README); delivery keeps the retry and acknowledgement behaviour below.

Behaviour:
- Disabled kinds are not polled; they stay unsent and are sent if you enable them later. Changing the channel
  affects only events that are not delivered yet; delivered events are never replayed. There is no backfill.
- One serial loop: a pass lists due events, posts each one, then marks it delivered. Passes never overlap.
- Delivery is at-least-once with simple semantics. If the process crashes after Slack accepted a post but before the
  API was told, the event is posted again after restart (a rare duplicate). While the process lives, a failed
  acknowledgement is retried without reposting. Capture on the API side is best effort, so a crash can also lose an event.
- A transient failure (network, timeout, 5xx, Slack 429) is reported as failed with a retry time: capped exponential
  backoff with jitter, or Slack's `Retry-After` when longer. Permanent errors (`invalid_auth`, `channel_not_found`,
  `not_in_channel`, `is_archived`, `missing_scope`, …) stay failed without automatic retry; fix the cause and
  reset the event in the database or wait for a new occurrence. API errors back off the loop the same way.
- Run **exactly one** channels replica with notifications enabled: there is no claim or lease, so two workers would double-post.
- Troubleshooting: the log shows event ids and sanitized reasons (never tokens). `Slack error: not_in_channel` means
  the bot was not invited; `invalid_auth` means a wrong or revoked `SLACK_BOT_TOKEN`; repeated `Gilde API` errors mean
  `GILDE_API_URL`/`GILDE_API_KEY` are wrong or the API is down.

Messages link to `GILDE_PUBLIC_URL/?project=<id>&job=<id>` (opens the job in the board) or `/features/<id>`.

## The bot user and its API key

```sh
pnpm --filter @gilde/api user:create --email bot@example.com --name "Gilde bot"
pnpm --filter @gilde/api apikey:create --email bot@example.com --name channels
```

The second command prints the key (`gk_…`) once. Put it in `GILDE_API_KEY`. Co-pilot tools and
memory then run as this user.

## Slack app setup

1. Create an app at <https://api.slack.com/apps> ("From scratch").
2. **Socket Mode**: enable it. Generate an app-level token with the `connections:write` scope; this is `SLACK_APP_TOKEN` (`xapp-…`).
3. **OAuth & Permissions**: add bot token scopes `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `reactions:read`, `reactions:write`, `users:read`. Install the app to the workspace; the bot user OAuth token is `SLACK_BOT_TOKEN` (`xoxb-…`).
4. **Event Subscriptions**: enable, and subscribe to the bot events `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`.
5. Invite the bot to a channel and mention it. It answers in the thread.

The scopes and events above follow the Channels Slack guide as far as it could be checked from the
package; compare with <https://docs.copilotkit.ai/channels> when setting up and adjust if the guide differs.

## Run

```sh
pnpm --filter @gilde/channels dev     # watch
pnpm --filter @gilde/channels build
pnpm --filter @gilde/channels start
pnpm --filter @gilde/channels test
```

## Adding a platform

For notifications, implement `OutboundAdapter` (`src/notifications/types.ts`: `send(notification, context)`, throw
`NotifyError` with `permanent` and optional `retryAfterMs`) and add an `OutboundEntry` to `OUTBOUND_ENTRIES` in
`src/notifications/outbound-adapters.ts` (e.g. Teams). Events and the API do not change. Slack posts use the Web API
over `fetch` because CopilotKit Channels only exposes conversational adapters (reply to an incoming event), not proactive posts.

For chat, add one entry to `ADAPTER_ENTRIES` in `src/adapters.ts` that returns the adapter when its credentials are set,
and the variables to `src/config.ts`.
