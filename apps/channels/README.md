# @gilde/channels

A separate long-running process that runs the Gilde co-pilot in chat platforms with
[CopilotKit Channels](https://docs.copilotkit.ai/channels). It reaches the `gilde` agent of the API
remotely over AG-UI (`MastraClient` + `@ag-ui/mastra`, base URL `${GILDE_API_URL}/v1/mastra`) and
authenticates with the API key of a bot user. For now every chat user is served as that bot user.

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

Add one entry to `ADAPTER_ENTRIES` in `src/adapters.ts` that returns the adapter when its credentials are set,
and the variables to `src/config.ts`.
