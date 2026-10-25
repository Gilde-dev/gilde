# Gilde

Control plane of an AI factory. See `AGENTS.md` for the repository layout and commands.

## Postgres

By default the API uses SQLite (`db.sqlite`). To use Postgres instead:

1. Start Postgres: `docker compose up -d`
2. Set `DATABASE_URL=postgres://gilde:gilde@localhost:5432/gilde` (see `apps/api/.env.example`) and run `pnpm dev`.

## GitHub webhooks (local)

GitHub delivers webhooks to a [smee.io](https://smee.io) channel; the `webhooks` compose service forwards them to the API on your machine. Only webhook deliveries are forwarded, so the API itself stays private.

1. Open https://smee.io, click **Start a new channel**, and put the URL in `.env` as `SMEE_URL` (see `.env.example`).
2. Start the forwarder: `docker compose --profile webhooks up -d` (logs: `docker compose logs -f webhooks`).
3. In the GitHub repo: **Settings → Webhooks → Add webhook**
   - Payload URL: your `SMEE_URL`
   - Content type: `application/json`
   - Secret: the same value as `GITHUB_WEBHOOK_SECRET` in `apps/api/.env`
   - Events: Pull requests, Check suites, Pull request reviews, Pull request review comments, Issue comments

Anyone with the channel URL can read the payloads, so keep it private; the API's signature check rejects forged deliveries. smee.io is meant for development; for 24/7 operation, run Gilde on a server with its own domain.

## Reviewing agent PRs

Request changes on a job's PR and Gilde sends the job back to its agent with your review (plus its inline comments) as the reason. GitHub does not let you request changes on your own PR, and agent PRs are opened under the owner account, so there are two other ways:

- **Comment `/gilde retry [what to change]`** on the PR (case-insensitive, must start the comment). Only OWNER, MEMBER and COLLABORATOR comments count; the text after the command is the reason (default: "Address the review comments on the PR."), and inline review comments the agent has not pushed after yet are appended. Comments from others are only stored as feedback.
- **Send back to agent** button on the job card and in the job detail (`POST /api/v1/jobs/:id/send-back` with `{ "reason": "..." }`).

Both only work while the job is `pr_open` or `awaiting_review`; the agent continues on the same branch and PR, and each send-back uses one attempt (the job is parked at the project's max attempts).

## Agent instructions

Agents get their working instructions from [`docs/agent-instructions.md`](docs/agent-instructions.md):
how to read the job payload, branch, test, and format the PR body that Gilde parses
(`gilde-job`, `gilde-run`, the `gilde-result` block and `## Retro`).

Gilde sends this file with every job when `AGENT_INSTRUCTIONS_PATH` points to it (see `apps/api/.env.example`).
The file is re-read when it changes, so edits apply without a restart. Each run records the version
(first 12 hex chars of the sha256) as `instructionsVersion`, `GET /api/v1/jobs/:id/prompt` shows exactly what the
next fire would send, and `/metrics` compares versions. Changing the job payload or the PR body format means
updating this file in the same PR.

The routine itself only needs this two-line description:

> You are run by Gilde. Each message contains your full working instructions followed by a job payload. Follow those instructions exactly; they take precedence over anything in this routine description.
