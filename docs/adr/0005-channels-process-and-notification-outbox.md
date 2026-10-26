# 0005. Run chat platforms in a separate channels process with an API notification outbox

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** PR #50 (commit a5a8953, channels app), PR #66 (commit e77fb7b, notification store and API), PR #68 (commit 877aa82, Slack notifications worker); recorded retrospectively

## Context

Gilde wants its co-pilot available in chat (Slack first) and wants to tell people when something needs them (a PR awaits review, a job is parked). Chat platforms need their own credentials and long-lived connections, and a platform outage must not take down the API, dispatcher or webhooks. Notifications must not be lost when Slack or the consumer is down.

The history shows the implementation but no written comparison of options; the alternatives are retrospective.

## Decision

- Chat runs in a separate Node process, `apps/channels` (`@gilde/channels`, its own image, ADR 0002), using CopilotKit Channels. Adapters are listed in `src/adapters.ts`; today only Slack, enabled when both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set (Socket Mode, so no public inbound endpoint is needed; `README.md`). Platform credentials live only in this process's environment.
- The process reaches the co-pilot remotely over AG-UI against `/api/v1/mastra` (ADR 0004) and authenticates with an API key (`GILDE_API_KEY`) of a bot user (ADR 0003). `identifyUser: 'platform'` is used and chat users are not mapped to Gilde users yet, so every chat user acts as the bot user.
- Notifications use an outbox in the API (`apps/api/src/notification/`): events are recorded as platform-neutral rows (kinds such as `job.awaiting_review`, `job.parked`) with a delivery status (`pending`, `delivered`, `failed`) and a retry time. The channels process polls `GET /api/v1/notifications` (due rows), posts to Slack, then calls `POST /:id/delivered` or `POST /:id/failed`. Formatting and destination (a Slack channel) belong to the channels process; the API stores only events. The worker (`src/notifications/worker.ts`) is one serial loop with capped exponential backoff and jitter, off unless `NOTIFICATIONS_ENABLED=true`.
- The worker documents itself as at-least-once: a crash between posting and acknowledging resends; while the process lives, an unacknowledged success is re-acknowledged instead of reposted. Notifications run independently of chat, so a chat startup failure does not stop them (`src/main.ts`).

## Consequences

- Positive: Slack problems and its credentials stay out of the API; the API needs no outbound Slack access. Events survive consumer downtime and can be retried. The API stays platform-neutral, so another platform means a new adapter in `apps/channels`.
- Negative: one more process to deploy and monitor. Polling adds delay (default 15 s) and constant light load. Delivery can duplicate messages after a crash between post and acknowledgement. The store is designed for a single consumer. Everything chat users do is attributed to the bot user.
- Follow-up: map chat users to Gilde users. Tools that need approval (ADR 0004) have no Slack interaction yet in this code.

## Alternatives considered

Retrospective comparisons.

- **Slack inside the API process** — fewer moving parts, but ties API availability and credentials to Slack.
- **API pushes notifications to Slack directly** — immediate, but a Slack outage or error must then be handled in domain code, and retries need storage anyway.
- **Webhook or event push to the consumer** — lower latency; needs a reachable endpoint and delivery handling on both sides.
