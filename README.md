# Gilde

Control plane of an AI factory. See `AGENTS.md` for the repository layout and commands.

## Local development

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts the API (port 4100), the web UI (port 3000) and the channels process together with prefixed output; Ctrl+C stops all. If one app exits (channels exits with code 0 without Slack credentials), the others keep running. To start a single app use `pnpm dev:api`, `pnpm dev:web` or `pnpm dev:channels`.

Changes to source files reload automatically. Channels also restarts when its `.env` changes; for the API, restart `pnpm dev` after changing `.env`. Run `pnpm install` after a pull that changes dependencies.

## Container images

Each app has a multi-stage Dockerfile that is built with the repository root as context. The images run as the non-root `node` user and contain no `.env` files, databases, workspace clones or `.git` (see `.dockerignore`).

```sh
docker build -f apps/api/Dockerfile -t gilde-api .
docker build -f apps/web/Dockerfile -t gilde-web .
docker build -f apps/channels/Dockerfile -t gilde-channels .
```

### Publishing

`.github/workflows/images.yaml` builds the three images (linux/amd64) and publishes them to `ghcr.io/gilde-dev/gilde-api`, `ghcr.io/gilde-dev/gilde-web` and `ghcr.io/gilde-dev/gilde-channels`. Each image gets two tags: the full commit SHA and `latest`, plus the OCI labels `org.opencontainers.image.source` and `org.opencontainers.image.revision`.

- Images are pushed only after the CI workflow succeeded on `main` for that commit (or by a manual `workflow_dispatch` on `main`), so broken commits never get images.
- Pull requests build the same images without pushing (checks named `Image api`, `Image web`, `Image channels`).
- The workflow uses only the built-in `GITHUB_TOKEN` (`contents: read`, `packages: write`) and has no deploy step.
- The GHCR packages must be readable by the server: make them public, or configure a token with `read:packages` in gilde-infra. A newly created package starts private.

Deployment is done from the separate `Gilde-dev/gilde-infra` repo (compose file, Caddy, env files, backups); this repo only produces the images.

Environment variables per image:

- **api** (listens on `PORT`, default 4100; healthcheck `GET /api/health`): `DATABASE_URL` (`postgres://`, migrations run on startup), `JWT_SECRET` (at least 32 chars), `WEB_ORIGIN`, `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `OPENAI_API_KEY` and `COPILOT_MODEL` (co-pilot). Preset in the image: `GILDE_WORKSPACE_DIR=/data/workspace` (mount a volume there; it is writable by the runtime user) and `AGENT_INSTRUCTIONS_PATH=/app/docs/agent-instructions.md`. Optional: `JWT_EXPIRES_IN`, `GILDE_CI_WORKFLOWS`, `GILDE_GATE_WORKFLOWS`, `COPILOT_MAX_BODY`. The API trusts exactly one proxy hop (`trust proxy 1`), so run it behind one reverse proxy only.
- **web** (listens on 3000, `HOSTNAME=0.0.0.0`): `GILDE_API_URL` (for example `http://api:4100/api`), read at runtime on the server, never baked into the build. The session cookie is `Secure` because `NODE_ENV=production`.
- **channels** (no ports): `GILDE_API_URL`, `GILDE_PUBLIC_URL`, `GILDE_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`.

Create the first user and an API key inside the running api container (the compiled CLIs need neither pnpm nor dev dependencies):

```sh
docker compose exec api node dist/cli/user-create.js --email you@example.com --name "Your Name"
docker compose exec api node dist/cli/apikey-create.js --email you@example.com --name channels
```

## Postgres and migrations

By default the API uses SQLite (`db.sqlite`) with `synchronize`, so local development needs no migrations. To use Postgres instead:

1. Start Postgres: `docker compose up -d`
2. Set `DATABASE_URL=postgres://gilde:gilde@localhost:5432/gilde` (`postgresql://` also works; see `apps/api/.env.example`) and run `pnpm dev`.

With Postgres the API never synchronizes the schema: it applies the migrations in `apps/api/src/migrations/` on startup (`migrationsRun`). The first one, `InitialSchema`, creates the whole Gilde schema (the migration uses `uuid-ossp`, so the database user must be allowed to `CREATE EXTENSION`). Mastra tables are not part of it; Mastra creates and manages its own storage and vector tables.

The compose service uses the `pgvector/pgvector:pg16` image, which has the pgvector extension available. Mastra's `PgVector` runs
`CREATE EXTENSION IF NOT EXISTS vector` itself when it creates an index, so no init script is needed. **Existing Postgres setups:**
switching the compose image keeps the data volume (same major version), but run `docker compose pull && docker compose up -d` to
recreate the container. A self-managed Postgres needs the pgvector package installed (`CREATE EXTENSION` needs the right to create
extensions, or run `CREATE EXTENSION vector;` once as a superuser). Without pgvector, only vector features fail (see Degraded operation);
the rest of the API is unaffected. Without `DATABASE_URL`, co-pilot memory and vectors live in the LibSQL file `mastra.db`
(gitignored, override with `MASTRA_DB_URL`, e.g. `file:/data/mastra.db`); keep that file on persistent storage to keep memory across restarts.

An existing database that was created by the old `synchronize` setup has no `migrations` table: use a fresh database and the copy below instead of pointing the API at it.

### Changing the schema

1. Change the entity (snake_case columns, see `.claude/skills/typeorm-snake-case-columns`).
2. With Postgres running and `DATABASE_URL` set, run `pnpm --filter @gilde/api migration:generate <Name>`. It builds the API and writes `apps/api/src/migrations/<timestamp>-<Name>.ts`.
3. Review the SQL and commit the migration together with the entity change.

All migration scripts build the API first and run the TypeORM CLI against `dist/data-source.js`, which needs a Postgres `DATABASE_URL`:

- `migration:run`: apply pending migrations
- `migration:revert`: undo the last migration
- `migration:check`: exits non-zero when the entities and the migrations differ (an entity changed without a migration), without writing anything; use it to verify that you did not forget a migration

### Copying SQLite data to Postgres (once)

`pnpm --filter @gilde/api db:copy-sqlite-to-postgres [--sqlite <path>]` moves all Gilde tables from `apps/api/db.sqlite` (or the path in `--sqlite` / `SQLITE_PATH`) into Postgres. It keeps ids and timestamps, inserts in foreign-key order in one transaction, refuses to run when any target table already has rows, and prints the row count per table.

1. Start with an empty database and let the API (or `pnpm --filter @gilde/api migration:run`) apply the migrations.
2. Stop the API so SQLite is not written to, then run the command with `DATABASE_URL` pointing at the target.

Not copied: Mastra data (`mastra.db`). Co-pilot conversations and the history index start fresh; rebuild the history index with `POST /api/v1/history/rebuild`. Timestamps are copied as the UTC wall-clock values SQLite holds, so run the API against Postgres with `TZ=UTC` (the default in containers).

To run it from a laptop against the server's Postgres, open an SSH tunnel to the Postgres container and point `DATABASE_URL` at the local end:

```sh
ssh -L 5432:<postgres container address>:5432 <server>
DATABASE_URL=postgres://<user>:<password>@localhost:5432/<db> pnpm --filter @gilde/api db:copy-sqlite-to-postgres
```

Alternatively copy `db.sqlite` to the server and run the command from a container of the stack (`docker compose exec`), where `DATABASE_URL` is already set. If a local Postgres already listens on 5432, tunnel to another local port (`-L 5433:...`) and use it in the URL.

## Co-pilot memory

The co-pilot uses Mastra's built-in `Memory` on the shared infrastructure in `apps/api/src/memory/` (storage, vector stores and the
embedder, below the co-pilot and the dispatcher). Per user it has the last 20 messages of the thread, **working memory** (a short
preferences template, kept across all threads) and **semantic recall** of older conversations in any thread of the same user.

**Identity.** The memory resource is the authenticated Gilde account (JWT or API key owner), on every `/api/v1/mastra` route.
Requests without an authenticated account are refused (no anonymous or shared memory). A `resourceId`/`memory.resource` naming another
account gets `403`; a thread or message id owned by another account gets `404` (on the read, write, delete, clone and CopilotKit routes), and on
memory routes the `resourceId` query parameter is pinned to the caller. A channel that talks to the API with one bot API key (e.g. Slack) shares
that bot account's memory between everyone in that channel; mapping chat users to Gilde users is not done.

**OpenAI data.** With `OPENAI_API_KEY` set, the text of co-pilot messages is sent to OpenAI's embeddings API (`text-embedding-3-small`, 1536
dimensions) to index it for recall, and recalled messages are sent to the chat model like any other context. Embedding cost is small
(about $0.02 per million tokens for the default model). Set `MEMORY_EMBEDDING_MODEL` / `MEMORY_EMBEDDING_DIMENSION` to change the model;
the key is independent of `COPILOT_MODEL`. Personal memory is never written to the shared history index (`gilde_history_<dimension>`),
which is a separate vector store and index.

**Changing model or dimension.** Vectors from different models/dimensions must not be mixed. Mastra names the recall index after the
dimension, and the history index is `gilde_history_<dimension>`, so a new dimension starts a fresh, empty index and old messages are no longer
recalled until re-embedded. Same dimension but another model: drop the old indexes first (`memory_messages_<dimension>` and `gilde_history_<dimension>`
in the vector store, e.g. `DROP TABLE` in Postgres, or delete `mastra.db`'s vector tables) so they are rebuilt. Conversations and working memory
are not touched by this.

**Degraded operation.** Without `OPENAI_API_KEY` the API starts normally (a warning is logged), no embedding request is ever made, and the co-pilot keeps
last-20-message context and working memory but has no semantic recall. If the vector store is unavailable (no pgvector, database down),
recall and history search report errors; job dispatch does not depend on the co-pilot, memory or vectors.

**Tests.** Automated tests use a deterministic fake embedder (`memory.testing.ts`) and a mock model on real local LibSQL files; nothing calls OpenAI.
**Postgres/pgvector smoke check:** `docker compose up -d`, then
`PGVECTOR_SMOKE_URL=postgres://gilde:gilde@localhost:5432/gilde pnpm --filter @gilde/api test -- memory.pgvector`
(creates and drops a `gilde_smoke_*` index and checks insert/query with the fake embedder).

## Chat page

`/chat` is a full-page chat with the `gilde` co-pilot, next to the signed-in user's earlier conversations (newest first,
"New conversation" starts an empty thread). The collapsible co-pilot sidebar stays on every other page; on `/chat` it is
not rendered, so there is only one chat at a time. Below `md` the conversation list sits behind a button. Without
`OPENAI_API_KEY` and `COPILOT_MODEL` the page shows the "Co-pilot not configured" note.

- Conversations are the co-pilot's Mastra memory threads (Postgres on `DATABASE_URL`, otherwise `mastra.db`), one thread per
  conversation with the user id as resource. CopilotKit's `CopilotThreadsDrawer`/`useThreads` are not used: in 1.80 they need
  CopilotKit Intelligence, a paid cloud platform that stores conversations outside Gilde.
- `GET /api/v1/copilot/threads` returns `{ id, title, createdAt, updatedAt }` of the caller's own threads; `GET
  /api/v1/copilot/threads/:id/messages` returns one thread's messages as chat history. The user comes from the token. Threads
  of other users, and of bot users (the Verkenner scout, the Slack bot), are never listed, and another user's id is a 404.
  The title is Mastra's thread title when set, otherwise the first user message cut to 60 characters, otherwise "Untitled
  conversation".
- The AG-UI Mastra agent does not replay history on connect, so the page loads the messages through the endpoint above and
  sets them on the agent (`agent.setMessages`) before the chat mounts, with the thread id on the chat configuration. The next
  message then continues the same Mastra thread.

## Blocked results and merged-without-work

An agent reports `blocked` in its `gilde-result` block when it could not do the task. Gilde treats that as follows:

- **Park.** When the *current* run's stored result is `blocked` (the latest attempt, re-read after the result was written; an older attempt's body or a write that did not land never counts), the job is parked through the state machine with the reason `Blocked: <run summary>. Close the PR, fix the cause, then retry.` This does not use up attempts and does not requeue. The park happens when the PR is linked, when the PR body is edited, and when the reconciler finds the PR; it is a conditional transition, so redeliveries and concurrent calls park and notify (`job.parked`, cause `blocked`) once. CI, review and new-commit events do not pull a parked job back; you retry it yourself. A later run with a non-blocked result follows the normal path. `partial` results are unchanged.
- **Merged without work.** If the blocked PR is merged on GitHub anyway, the job still becomes `merged` (the status counts stay factual), but `mergedBlocked` is true on the job, in lists and details. It is kept in `jobs.merged_blocked`, set from the stored result of the job's latest run when the job is merged or its body is edited later, and backfilled by the migration (SQLite, which synchronizes its schema, has no backfill). Done, partial and results-less merges are unaffected.
- **Dependencies.** A merged-without-work job does not satisfy a dependency: it stays in the dependents' `blockedBy` (with `mergedBlocked: true`), `failedDependency` is true, and the dispatcher neither claims nor fires those dependents, so they take no slot or daily allowance. Unrelated jobs still run.
- **Verkenner.** The board state reports `mergedWithoutWork` (exact count, at most 20 ids) next to the factual status counts.
- **Recreate job.** `POST /api/v1/jobs/:id/recreate` (also on the board, the job modal and the job page, with a confirmation) is the recovery for a merged-without-work job. It creates a new job in triage for the acting user with the same repo, title, task, acceptance criteria, feature and its own prerequisites, and points every dependency edge that targeted the original at the new job, whatever the dependents' status; the dependents are not reset or started. The original and its PR stay untouched, nothing is queued, and repeated or concurrent requests return the same replacement (`replacedById` on the original). Only merged-without-work jobs qualify (409 otherwise). Queue the new job when you are ready.

## Bot accounts

`users.is_bot` (default `false`) marks machine accounts: the channels bot and the Verkenner scout. Bots authenticate with API keys and can
never pass `requireVerifiedHuman` (`common/verified-human.ts`, used through `UserService.requireVerifiedHuman`), the opt-in gate for
human-only operations. It accepts only a persisted non-bot account that signed in with a verified JWT: API keys (even of a human),
bots, deleted users and the `SCOUT_USER_EMAIL` account are refused (403), and the account is re-read on every call, so a stale token
cannot outlive a bot marking. Credential provenance (`req.user.credential`: `jwt` or `api_key`) is set by the server after a successful
authentication only, never from a token claim, header or body; it reaches Mastra tools as `copilotUser(...).credential`. With
`AUTH_ENABLED=false` no request has provenance, so human-only routes add `JwtHumanGuard`, which always verifies a real JWT.

```sh
# a new bot account (prompts for a password)
pnpm --filter @gilde/api user:create --email channels@example.com --name "Gilde Channels" --bot
pnpm --filter @gilde/api apikey:create --email channels@example.com --name channels   # GILDE_API_KEY for apps/channels

# the Verkenner account
pnpm --filter @gilde/api user:create --email verkenner@example.com --name Verkenner --bot

# mark an existing account (idempotent, the password is untouched)
pnpm --filter @gilde/api user:mark-bot --email verkenner@example.com
```

## Verkenner (scout agent)

Verkenner is an opt-in, unattended second Mastra agent (`id: verkenner`) next to the co-pilot (`gilde`). It will connect recorded factory
events to well-supported follow-up suggestions. It lives in the same Mastra instance and shares its storage (`MemoryInfrastructure`:
Postgres in production, LibSQL locally) and memory. **Status:** complete: gated registration, project threads, read tools, the verified signal APIs,
event publishing, wake budgets, the daily summary, bounded `suggestJob` triage suggestions, and the Suggested badge and metrics on the board. Design notes: [ADR 0007](docs/adr/0007-verkenner-scout-may-create-triage-jobs.md).

**Configuration** (all in the API environment; see `apps/api/.env.example`):

| Variable | Meaning |
|---|---|
| `SCOUT_ENABLED` | must be exactly `true`; anything else (or unset) keeps the scout off |
| `SCOUT_USER_EMAIL` | email of an **existing** bot user the scout acts as |
| `SCOUT_MODEL` | `openai/<model>`; falls back to `COPILOT_MODEL`; needs `OPENAI_API_KEY` |
| `SCOUT_SUMMARY_HOUR_UTC` | integer 0..23, default `6`: hour of the daily summary |
| `SCOUT_MAX_WAKES_PER_DAY` | positive integer, default `6`: wakes per project per UTC day |
| `SCOUT_DAILY_SUGGESTIONS` | positive integer, default `3`: suggestions per project per UTC day |

The scout is configured independently of the co-pilot: a valid scout configuration also works when `COPILOT_MODEL` is unset (the
co-pilot is then off and its routes answer 503). A missing flag, user, model or key, an unknown user, or an explicit invalid number
leaves the scout **off**, logs a reason (never a secret or the email) and the API starts normally. `GET /api/v1/copilot/status` reports
`{ enabled, model, scout: { enabled, model } }`. Use a recognisable display name for the bot (**Verkenner** is recommended): it is shown as the creator of its jobs.

**Bot user setup.** The scout acts as a normal user that you create once; Gilde never creates it, and it needs no API key:

```sh
pnpm --filter @gilde/api user:create --email verkenner@example.com --name Verkenner
```

then set `SCOUT_ENABLED=true` and `SCOUT_USER_EMAIL=verkenner@example.com` and restart the API.

**Identity and isolation.** The memory resource is the bot user's id and there is one thread per project, `verkenner:<projectId>`,
created by the server. A scout run receives its project from a server-issued binding that is attached when a notification starts the run
(immediately or from the scheduler); tools never take the project or user from their input and check every id the model passes against it.
The scout is refused (`403`) on every `/api/v1/mastra` route, so a user cannot run it, send it a request context, or list it in CopilotKit;
the bot's threads belong to the bot (`404`/`403` for everyone else). Its memory is scoped to the thread (no resource-wide working memory or recall)
so projects do not mix.

**Tools.** An explicit allowlist: read tools for repos, jobs, features, lessons, history search and repo code of its own project, the native
notification inbox pinned to its own thread, and `suggestJob`. It has none of the co-pilot's plan/create/validate tools and nothing that edits, queues,
starts, retries or cancels work, creates features, applies lessons or touches the co-pilot. Capability: **read plus triage-only suggestions**.

**Signal semantics (verified).** Notifications are stored in a native inbox before delivery; `high` wakes an idle thread, `low`/`medium` can be
held for a `<notification-summary>` that a Mastra scheduled dispatch emits when due; a repeated `dedupeKey` only coalesces while the record is still pending;
state signals with an unchanged `cacheKey` are skipped and need an existing thread. The exact imports, options and observed behaviour are in
[docs/verkenner-signals.md](docs/verkenner-signals.md).

**Events and signals.** Six recorded events are published into the scout's native inbox (`source: gilde`), after the existing write succeeded.
Nothing is published while the scout is off, nothing is replayed at startup (only events after enablement), and a failure anywhere
(enrichment, storage, model) is logged and never reaches the code that recorded the event, nor the Slack/channels outbox, which is untouched.

| Event | Where it is published | Kind | Priority |
|---|---|---|---|
| Blocked or partial run result | `JobEventsService.recordProposals` (shared by initial PR linking and edited PR parsing), only when the run row really stores that result, whether or not proposals are collected | `run-blocked`, `run-partial` | high |
| Job parked (every capture path: CI failure, sent back, dispatch failure) | `NotificationCaptureService.jobParked` | `job-parked` | high |
| Changes requested on an agent PR | `FeedbackService.record`, for a newly stored `changes_requested` review | `review-changes-requested` | medium |
| New lesson candidate | `LessonCollectorService`, after the lesson and its source committed | `lesson-new` | low |
| Feature closed | `FeatureService.done` (a successful active to done; not "ready to close", not cancel) | `feature-done` | low |
| Job merged | `JobEventsService.prClosed` | `job-merged` | low |

There is deliberately no repeated-CI-failure event; CI problems show up through blocked/partial results and parked jobs. A signal carries a one-line
summary of at most 240 characters with ids, and a payload limited to ids, status, repo name and a few numbers (`jobId`, `runId`, `featureId`,
`lessonId`, `feedbackId`, `repoId`, `repo`, `outcome`, `status`, `cause`, `attempt`, `prNumber`). PR bodies, tasks, diffs, reasons, retros and review
text are never copied; the scout reads them by id with its tools. Producers only depend on a small publisher (`apps/api/src/scout-signal/`),
so the co-pilot and the domains do not import each other.

**Dedupe.** The native inbox only coalesces a `dedupeKey` while the first record is still pending, so each event also claims a durable receipt
(`scout_signal_receipts`, unique per project and key) before it is sent. The key is built from event identity, never the clock: run id and
outcome, job id + attempt + head + cause, feedback id, lesson id, job id, feature id + `doneAt` (so reopening and closing a feature again is a new
occurrence). Redelivery, concurrent redelivery and a restart publish once. If sending fails, the receipt is removed so a redelivery can retry.

**Delivery policy and budget (UTC).** `high` events wake the scout at once, but only inside a durable per-project, per-UTC-day budget
`SCOUT_MAX_WAKES_PER_DAY` (`scout_wake_days`; a conditional update, so concurrent calls, several processes and restarts cannot exceed it). Summaries
count against the same cap. While backlog that would wake the agent (medium, low or over-budget events) is waiting and today's summary is
not yet claimed, one slot is reserved for it. `medium`, `low` and over-budget `high` events stay `pending` in the inbox with a `summaryAt` of the
next `SCOUT_SUMMARY_HOUR_UTC`. The delivery policy (`scout-delivery-policy.ts`) is the only thing that can wake the agent: it delivers an event only if a
wake was claimed for it, and when Mastra's scheduled dispatch (cron `*/5 * * * *`, created lazily by Mastra) finds a summary due it
claims the project's one summary of the day (from the summary hour on, once per UTC day, only while a wake is left) or `hold`s the records, which
stay pending until the next eligible day. A summary of low-priority records only is persisted by Mastra without waking the agent, so it costs no
wake. A claimed wake is not given back once the signal was handed to Mastra (an ambiguous failure may still have woken the agent); it is
given back only when sending provably never started. `lastWakeAt` is the actual last wake (stored per project and day; read through
`ScoutWakeReader`), not the arrival of a signal. Decisions of one project are serialized in the process.

**Global budget gate.** While the GLOBAL estimated budget (day or week) is hard, or cannot be read (fail closed), the scout sends **no native high wake and no daily summary** (`ScoutSignalService`: `globalBudgetHard`). A high event is then stored like an over-quota one (`pending`, `wake: deferred`, no board state sent) and no wake or summary quota is claimed; `allowSummary` holds the due records, which stay pending in the inbox, so nothing is lost and nothing wakes the agent as an immediate catch-up. After the budget clears, the next dispatch pass sends the backlog in the next eligible daily summary. Project budgets do not gate the scout.

**Board state.** Before an actual high wake and before a daily summary the scout gets a project board as a native state signal (`id: board`):
exact job counts for every status (aggregated in the database through `JobService.statusSnapshot`, not the capped job list), up to 20 parked job
ids and up to 20 open (draft or active) feature ids with their count. The `cacheKey` is a hash of that content, so an unchanged board is not
sent again, and it is never sent for queued medium/low events.

**Suggestions (`suggestJob`).** The scout's only mutation. Input: `repoId`, `title`, `task`, `acceptanceCriteria`, `reason` and a non-empty
`basedOn` (ids of runs, jobs, lessons or features it looked at). There is no actor, project or status parameter: the project and the bot user come
from the server-issued binding of the run (a look-alike or copied binding is refused as `untrusted_context`), and the repo and every evidence id are
resolved inside that project (`foreign_repo`, `foreign_evidence`, `invalid_evidence`, `missing_evidence`). The tool calls services only (`ScoutSuggestionService`,
`JobService.create`) and asks no approval: the human gate is triage. The service appends a final `## Why` section (the reason, `Based on:` the canonical
evidence ids and the marker `Suggested by Verkenner`) to the task, validates the assembled task against the job limits (shared `JobContentSchema`) and calls
`JobService.create` with explicit `status: 'triage'`, the bot as creator, no dependencies and no feature. The marker lives in the task text only; jobs have
no `suggestedBy` column. A human queues (approves), edits or cancels the job like any other.

Limits, all enforced by the server and all refusals return `{ created: false, stop: true, refusal: { reason, message, ids? } }` for the agent to stop on:

| Limit | Refusal | Rule |
|---|---|---|
| Daily quota | `daily_limit` | `SCOUT_DAILY_SUGGESTIONS` (default 3) successful suggestions per project per UTC day |
| Same evidence | `duplicate_evidence` | the sorted, unique, lower-cased `basedOn` set is hashed (SHA-256) and compared with **all** earlier suggestions in the project, whatever later happened to their jobs |
| Same title | `duplicate_title` | case-insensitive, trimmed title equal to any non-terminal job of the project (triage, queued, dispatched, pr_open, awaiting_review, parked), counted in the database, not in the capped job list |
| Off | `scout_off` | no suggestion is created while the scout is off |
| Invalid | `invalid_input`, `unknown_repo` | job limits (title 3-200, task 10+, 20 criteria of 3+, reason 10-2000, at most 20 evidence ids) |

A refusal writes nothing, so it never consumes the daily allowance. Quota, hash and title checks, the job and its receipt are **one transaction** under a
per-project lock row (`scout_suggestion_guards`: the first statement of the transaction updates it, which serializes callers and processes on Postgres; a
process-wide queue does the same for SQLite's single connection) and a unique index on `(project_id, evidence_hash)` is the last line of defence. The receipt
(`scout_suggestions`: project, job, actor, evidence hash, UTC day, time; no foreign key to the job, so the hash outlives cancellation or deletion) is written
with the job, so a crash or a failing receipt insert rolls the job back and a retry cannot create a second one. `JobService.create` has an optional
`manager` argument for this; existing callers and defaults (including the default status `queued`) are unchanged.

**Board and metrics.** `GET /api/v1/copilot/scout-activity?projectId=<uuid>` (authenticated; 400 for a malformed id, 404 for an unknown project) returns
`{ projectId, enabled, model, scoutUserId, suggestionsThisWeek, weekStart, lastWakeAt }`. `suggestionsThisWeek` counts the project's receipts from Monday 00:00 UTC
through now; `lastWakeAt` is the actual most recent wake (`null` = never); both come from the database and stay visible while the scout is off. `scoutUserId` is the
id of the user `SCOUT_USER_EMAIL` resolves to (also while the scout is off); the bot's email, credentials and inbox content are never returned. The board reads it once per
project and marks jobs whose `createdBy.id` equals it with a **Suggested** badge (never by name or task text, including in triage and for historical jobs while the
scout is off). The metrics page has a Verkenner section (on/off, suggestions this week, last wake or *Never*), scoped to the selected project and the current UTC
week, independent of the factory period and repo filters.

**Bookkeeping and storage.** Mastra owns its notification tables. Gilde adds `scout_signal_receipts` and `scout_wake_days` (snake_case, UUID project
references, SQLite-compatible; Postgres migration `1793300000000-ScoutSignals`) and `scout_suggestions` and `scout_suggestion_guards` (migration `1793400000000-ScoutSuggestions`). Jobs are not changed.

**Spike limitations.** Verified by `apps/api/src/copilot/verkenner.signals.spike.spec.ts` with the real `@mastra/core` 1.79.0, a real LibSQL store
and a stub model. The same spec ran against a real local Postgres 16 (opt-in, `VERKENNER_SPIKE_PG_URL`, skipped otherwise) and passed; the Postgres
run is not part of CI. The cron was not waited on (the dispatcher pass it triggers was run directly), only one process was used, and native
`dedupeKey` is not restart-safe after delivery, so event publishing keeps its own durable receipt.

## MCP server

Gilde can act as a remote MCP server so an operator's own MCP client (Claude Code first) can read the factory and put work into triage
without the co-pilot sidebar. It is a new external interface, see [ADR 0010](docs/adr/0010-mcp-server-for-operators-triage-and-draft-only.md).
**No infrastructure change is included**: this repo only adds the endpoint; publishing it is an infra decision outside this repo.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_ENABLED` | off | Only the literal `true` enables `POST /api/v1/mcp`. Off, the path is a plain 404, also without credentials. |
| `MCP_DAILY_JOB_LIMIT` | `20` | Jobs one user may create through MCP per UTC day, across all projects and keys. A planned feature's jobs count here. |
| `MCP_DAILY_FEATURE_LIMIT` | `5` | Features one user may create through MCP per UTC day. |

The limits are non-negative integers; `0` disables creating that kind. An empty, negative, fractional or non-numeric value stops the API at
startup instead of lifting the limit. MCP needs no LLM and no co-pilot configuration.

Authentication is the normal global guard: a personal API key (`gk_...`, create one at `/settings/api-keys`) or a JWT. Every tool call
re-reads the account: deleted users, bot accounts and the scout account (`SCOUT_USER_EMAIL`) are refused, and with `AUTH_ENABLED=false`
every tool fails closed. Connect Claude Code:

```bash
claude mcp add --transport http gilde <url>/api/v1/mcp --header "Authorization: Bearer gk_…"
```

Until infra exposes the path, open an SSH tunnel to the API and use `http://localhost:4100/api/v1/mcp` as the endpoint
(`claude mcp add --transport http gilde http://localhost:4100/api/v1/mcp --header "Authorization: Bearer gk_…"`).

The server is stateless (no session; `GET` and `DELETE` answer 405) and exposes exactly these 22 tools:

- Read: `listProjects`, `listRepos`, `listJobs`, `getJob`, `listFeatures`, `getFeature`, `listProposals`, `getDispatchStatus`, `getMetrics`,
  `listLessons`, `getRepoSkills`, `listSpecs`, `getSpec`, `searchHistory`, `listRepoFiles`, `readRepoFile`, `searchRepoCode`
- Validate only (write nothing, use no allowance): `validateJob`, `planFeature`
- Permitted writes: `createJob` (one job in `triage`, created by you), `createPlannedFeature` (a `draft` feature and its `triage` jobs,
  pinned to an approved spec version when given), `draftSpec` (a spec draft with `expectedVersion`)

Human-only, not available over MCP: queueing, dispatching, cancelling, retrying and merging jobs, approving specs, project and repo
settings, users and API keys, notifications and the co-pilot's memory. Failures (invalid drafts, a stale `expectedVersion` (409), daily
limits) come back as tool errors. Created jobs and features are logged as `audit source=mcp ...` (ids and caller only).

## Factory history (searchable)

A separate, shared index of what the factory has learned, built on the same Mastra vector store and OpenAI embedder as the co-pilot memory
(`apps/api/src/memory/history/`). It is project-scoped, never contains personal co-pilot conversations or working memory, and is a different
index (`gilde_history_<dimension>`) from the personal recall index.

**What is indexed** (source data stays the authority; chunks are at most 1200 characters, at most 8 per source):
- **Jobs and runs:** jobs that are `merged`, `rejected` or `cancelled`, plus `parked` ones (to learn from failures), and *every* run of them: attempt, run
  status, CI conclusion, agent result (outcome, summary, tests), error and retro. A missing result or retro is stored as such ("No agent result was
  recorded", "Retro: none recorded"). A job that is requeued or reopened stops qualifying and its chunks are removed until it is finished again.
- **Lessons:** `approved`, `applying` and `applied`. `candidate` and `rejected` lessons are never indexed; revoking an approval removes the chunks.
- **Feedback:** reviews and inline review comments with a non-empty body. Ordinary issue comments and `/gilde` commands are excluded.

**Freshness and operation.** The reconciler runs on startup and every minute; it starts a new pass when the last one completed more than 5 minutes ago
(`MEMORY_HISTORY_FRESHNESS_SECONDS`, default 300), so changes are searchable about five minutes after the source changed. A pass pages through jobs, runs,
lessons and feedback in batches (`MEMORY_HISTORY_BATCH_SIZE`, default 25) and does at most `MEMORY_HISTORY_MAX_BATCHES` (default 20) batches per run;
the cursor is saved after each batch (`history_state`), so a backfill of existing data continues across runs and restarts. Embedding requests are
sequential (64 chunks at most, 3 attempts with backoff). Only sources whose content hash changed are re-embedded (`history_entries` keeps the hash and chunk
count); chunks of deleted, edited-shorter or no-longer-eligible sources are deleted at the end of each kind. A failed batch keeps the cursor where it was and is
retried on the next tick; `GET /api/v1/history/status` shows progress, the last error and consecutive failures. Overlapping passes join the running one.
`MEMORY_HISTORY_INDEX=off` disables indexing and search. Without `OPENAI_API_KEY` nothing is indexed and search reports `unavailable`.

**Rebuild and recovery** (any authenticated user, like `POST /api/v1/dispatch`):
- `POST /api/v1/history/rebuild` waits for a running pass, drops the history index with all chunks and the bookkeeping, and starts a fresh backfill (it continues
  on the schedule; `POST /api/v1/history/reconcile` runs the next bounded part immediately). Use it after a vector-store incident, a restored database, or when
  you changed `MEMORY_EMBEDDING_MODEL` to another model of the same dimension. A changed model or dimension is also detected on the next run and rebuilds automatically.
- If the vector table was lost or pgvector was missing, install it (see the pgvector note above) and rebuild. Chunks that exist without bookkeeping (a crash
  between writing vectors and bookkeeping) are harmless, because search revalidates, and are removed by the next rebuild.
- Old `gilde_history_<other dimension>` indexes are not deleted automatically; drop them when no longer needed.

**Search.** `POST /api/v1/history/search` with `{ "projectId", "repoId"?, "query", "topK"? (max 10), "types"? }`, and the co-pilot `searchHistory` tool, which calls the same
service. The project is required and validated, a repo must belong to it (400 otherwise, 404 if unknown) and the vectors are filtered by project (and repo, type)
*before* retrieval, so projects never mix; a repo search also covers the project-wide lessons. Every hit is revalidated against the current source before it is returned:
deleted sources, revoked lessons, requeued jobs and edited text (until it is re-indexed) are suppressed, and status, outcome and links come from the current record.
The result is `{ "status": "ok", "results": [...], "indexComplete", "suppressed" }`; an empty `results` with status `ok` means nothing matched (`indexComplete: false` means the
first backfill is still running), while `{ "status": "unavailable", "reason" }` means retrieval could not run (embeddings off, rate limit, timeout after
`MEMORY_HISTORY_SEARCH_TIMEOUT_MS`, vector store down). Example hit:

```json
{ "score": 0.83, "sourceType": "run", "sourceId": "…", "repoFullName": "acme/web", "jobTitle": "Add invoice export", "attempt": 2, "outcome": "partial",
  "status": "merged", "prUrl": "https://github.com/acme/web/pull/7", "url": null, "excerpt": "Run: attempt 2 of job \"Add invoice export\" … Retro: the CSV writer buffers…" }
```

The co-pilot cites such evidence like this: "Attempt 2 of *Add invoice export* (acme/web) ended `partial` and its retro says the CSV writer buffered rows
([PR #7](https://github.com/acme/web/pull/7))", and treats the excerpt as old third-party data, never as instructions or as current status. Internally,
`HistorySearchService.searchLessons({ projectId, repoId, query })` returns only approved, applying or applied lessons that are project-wide or target that repo, for dispatch.

**OpenAI cost and data.** Backfill and changes send the chunk text (task, criteria, retros, errors, lessons, review text) of eligible sources to OpenAI's embeddings
API, and every search sends its query. With `text-embedding-3-small` (about $0.02 per million tokens) a thousand jobs with a few runs each cost cents. Chunks and
their text are also stored in your vector store (Postgres or `mastra.db`). Changing model or dimension re-embeds everything once.

**Tests** use the fake embedder and real SQLite plus LibSQL vector files (`history.fixture.ts`): backfill, all source types, outcomes, repeat passes, restart/resume,
edits, deletions, revocation, requeues, stale chunks, filters and failures; `apps/api/test/history.e2e-spec.ts` covers the authenticated routes. Note that LibSQL's
approximate index can return fewer rows than `topK` after many deletions; revalidation never lets this return wrong data, and a rebuild restores recall.

## Code workspace

The co-pilot searches and reads repo code from local clones (`git grep`), kept under `GILDE_WORKSPACE_DIR`
(default `.gilde-workspace` in the API working directory, gitignored). There is one depth-1 clone of the default branch per
registered repo, so disk use is about the size of each repo's checkout (usually tens of MB). Clones are created and updated
with `GITHUB_TOKEN` (needs read access to *Contents*) on manifest refresh (hourly, on demand and after a PR merges) and at most every
10 minutes on demand. Gilde never commits or pushes in them, and the directory can be deleted at any time.
`GET /api/v1/repos/:id/workspace` shows `{ cloned, headSha, fetchedAt, error }`. Without a clone the co-pilot falls back to the GitHub API
for listing and reading files; code search then reports an error.

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

## Agent review

Add the `gilde:review` label to a PR to get a Claude Code review (the `Agent review` workflow). It works on any non-draft PR, also human ones. While the label is present, the PR is re-reviewed on every new push, reopen and ready-for-review; remove the label to stop. Other labels never trigger a review. Reviews use the Claude subscription (`CLAUDE_CODE_OAUTH_TOKEN`), so apply the label deliberately.

## Claude Code telemetry (OTLP ingest)

Gilde can receive the OpenTelemetry events of Claude Code routines and store the token usage of each API request in `agent_usage`, separate from the co-pilot's `llm_usage`. Ingest only **stores** rows: `run_id`, `job_id` and `attribution` stay null and ingest never reads `job_runs`; a separate scheduled pass (below) attributes them.

**Endpoints.** Exactly two public POST routes, both OTLP/HTTP **JSON** (no protobuf):

- `POST /api/v1/otel/v1/logs`: `claude_code.api_request` log records are stored; every other event type is ignored.
- `POST /api/v1/otel/v1/metrics`: validated and acknowledged, never stored (the log events carry the same usage, so counting metrics too would double-count).

Both answer `200 application/json` with an OTLP `Export*ServiceResponse`: `{}` for full success, or `{"partialSuccess":{"rejectedLogRecords":N,"errorMessage":"..."}}` when N `api_request` records were malformed (the rest is stored; exporters do not retry partial success). A malformed envelope or invalid JSON is `400`, a storage failure is `503` (nothing is acknowledged, the exporter retries).

**Operator setup (Gilde).** Set `OTEL_INGEST_TOKEN` (for example `openssl rand -base64 48`) on the API. It is a dedicated secret: it is not a JWT or `gk_` API key and grants no access to any other route, and normal credentials do not work on the two routes. The routes are `404` when it is unset. A value shorter than 32 characters or starting with `gk_` fails closed: the routes stay `404`, the API still starts and logs a warning (never the value). The token check (constant-time) stays in force with `AUTH_ENABLED=false`. Keep the secret out of every environment except the routines Gilde fires. There is deliberately no project-scope setting.

Order of checks: throttle (429) -> `OTEL_INGEST_TOKEN` configured (404) -> bearer token (401) -> `Content-Type: application/json` (415). The 5 MB route-specific JSON limit (`413`) applies in the body parser and only for requests with a valid token: requests without it are never buffered, so they are answered `404`/`401` whatever their size. The body is not kept (`rawBody` is only kept for the webhook and co-pilot routes). Throttling: `OTEL_INGEST_RATE_LIMIT` requests per minute per client address and per route (default 120); above that the API answers `429` with `Retry-After`, which OTLP exporters retry. Login throttling is separate.

**Public proxy.** The reverse proxy in front of the API (gilde-infra, operator-managed, not in this repo) must forward exactly these two paths, `/api/v1/otel/v1/logs` and `/api/v1/otel/v1/metrics`, and nothing else new. Keep any later `/api/v1/usage/...` trigger off the public proxy.

**Routine environment (Claude Code cloud exporter).** Set these in the environment of the routine:

```sh
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_ENDPOINT=https://<domain>/api/v1/otel   # the exporter appends /v1/logs and /v1/metrics
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <OTEL_INGEST_TOKEN>"
```

Leave the content flags off (they are off by default; Gilde would not store the content anyway): do not set `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS` or similar.

**What is stored.** Only an allowlist of `api_request` attributes: session id, model, uncached input / output / cache-read / cache-creation token counts (kept separate), the cost and duration estimates (null when Claude Code supplied none, never 0), the event time and `service.version` / `organization.id`. Names are matched through an explicit alias map (`session.id`/`session_id`/`sessionId`, `input_tokens`/`inputTokens`, ...; see `ATTRIBUTE_ALIASES` in `apps/api/src/otel/otel-parser.ts`); the event name is read from the record's `eventName`, the `event.name` attribute or an exact body match, and the body is never parsed for anything else. Prompts, tool input/output, emails, resource attributes and all other attributes are never read, stored or logged. Numbers must be finite and non-negative, token counts safe integers up to 2147483647, strings bounded; nanosecond timestamps are read as exact integers.

**Deduplication.** `event_key` is a sha256 over session id, the full-precision nanosecond timestamp and the producer's `event.sequence` (or, when absent, a fingerprint of the allowlisted fields). It does not depend on arrival time, batch position or random ids, so retries and rebatching give the same key; a unique index plus `INSERT ... ON CONFLICT DO NOTHING` makes concurrent duplicates safe on SQLite and Postgres. Limitation: records in the same session and nanosecond that are identical in every allowlisted field and carry no sequence cannot be told apart and count once.

**Cost.** `cost_usd` is Claude Code's own estimate, not a Gilde price calculation. With a subscription it is notional (what the usage would cost at API prices), not what is billed.

**Smoke test** (synthetic, no real content):

```sh
curl -sS -X POST "https://<domain>/api/v1/otel/v1/logs" \
  -H "Authorization: Bearer $OTEL_INGEST_TOKEN" -H "Content-Type: application/json" \
  -d '{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"timeUnixNano":"1700000000000000000","body":{"stringValue":"claude_code.api_request"},"attributes":[{"key":"session.id","value":{"stringValue":"smoke-test"}},{"key":"model","value":{"stringValue":"smoke"}},{"key":"input_tokens","value":{"intValue":"1"}}]}]}]}]}'
# {}   (repeat it: still one row;  without the header: 401;  with the token unset on the server: 404)
```

Fixtures in the tests are constructed from Claude Code's documented attribute names; no real export was available, so equality of the real `session.id` with the routine's `claude_code_session_id` is unverified.

### Attributing usage to runs

**Session ids (evidence).** `routine-execution.adapter.ts` (`FireResponseSchema`/`fire`) passes the routine's `claude_code_session_id` through unchanged, `RunService.markFired` stores it in `job_runs.session_id` and stamps `fired_at`. Whether that value equals the OTel `session.id` was **not verified**: no real stored OTel session or routine response was accessible from the agent environment, so there is no real comparison to report (unavailable evidence), and all fixtures in the tests are synthetic. Matching is by the **exact** id only: there is no prefix stripping or other normalization. Operators can check it once with a sanitized pair (`SELECT session_id FROM job_runs WHERE session_id IS NOT NULL LIMIT 5` against `SELECT DISTINCT session_id FROM agent_usage LIMIT 5`); if they differ, exact matching never fires and only the start-time fallback applies.

**`finishedAt` is not used.** `JobEventsService.prClosed` stamps the last run's `finished_at` when the PR is merged or closed (to measure time-to-merge), so it is not the end of the routine execution. Attribution ignores `finished_at`, session end, coverage, run status and PR state; changing them never changes eligibility. Run lifecycle code is untouched.

**Operational premise.** The ingest secret (`OTEL_INGEST_TOKEN`) is stated to exist only in the environments of routines fired by Gilde, so every accepted session comes from a Gilde run. That permits a search across all projects; it is a premise, not something the code verifies. There is no project-scope setting.

**The pass** (`AgentAttributionService`, `apps/api/src/usage/`). It runs every five minutes (`@Cron(EVERY_5_MINUTES)`, like the reconciler) and on `POST /api/v1/usage/agents/attribute` (ordinary JWT or `gk_` API key; the ingest token is rejected, the route is never `@Public()`, keep it off the public proxy and out of the co-pilot). Both call the same method, take one `now` (injectable `clock`), skip when another pass is running in the same process (`skipped: true`) and make conditional updates, so overlapping or repeated calls are idempotent on SQLite and Postgres. It returns `{ skipped, sessionsExamined, sessionsBySession, sessionsByTimeWindow, sessionsAmbiguous, sessionsUnmatched, rowsAttributed, rowsUpgraded }`. Work is bounded (100 sessions per batch, at most 20 batches per pass, in session-id order), so a large backlog is backfilled by repeated passes.

1. **Quiet delay.** A session qualifies only when the latest event over **all** its stored rows is strictly older than ten minutes (`MAX(event_at) < now - 10 min`; exactly ten minutes does not qualify) and it still has unassigned rows or `time_window` rows. One recent event keeps the whole session back, even if other rows were already assigned.
2. **Exact match first.** If exactly one `job_runs.session_id` equals the session id (any project, no time restriction) its run and job are used with provenance `session`. Two or more matches are ambiguous: nothing changes and there is no fallback.
3. **Start-time fallback** (only when no exact match exists). `T` = the earliest event time over all rows of the session. Exactly one run, in any project, with `fired_at` in the inclusive interval `[T - 10 min, T]` gives provenance `time_window` for the still-unassigned rows. Runs without `fired_at` are not candidates. Zero or several candidates leave the rows unassigned; the nearest or latest is never chosen (two runs fired 30 seconds apart are ambiguous, also across projects). Example: a session whose first event is 20 minutes after the only run was fired stays unattributed, however long that run's PR stays open.
4. Job, project and repo come from the matched run.

**Provenance** (`agent_usage.attribution`): `session`, `time_window` or null. Run and provenance are written in one conditional update. Quiet `time_window` rows are revisited only so a unique exact match can upgrade them to `session` (replacing run and job). Every other assignment is frozen: no revocation, no reassignment when a later candidate appears or an earlier event arrives, no hook in ingest, run completion or any read endpoint. Rows ingested late start unassigned and wait for the next qualifying pass. The ten-minute quiet delay and the ten-minute start proximity are heuristics, not proof of completeness or ownership: a late earlier event may change `T`, and a delayed-start session stays unattributed.

### Agent usage totals

`AgentUsageService` aggregates in SQL with joins (no list caps, no per-item queries): `totals`, `unattributed`, `forRuns`, `forJobs`, `forFeatures`, `byRepo`, `byFeature`, `byModel` and `byDay`. Keys follow the co-pilot's `UsageTotalsDto`, with `cacheCreationTokens` added: `inputTokens` = uncached + cache read + cache creation, `cachedInputTokens` is the cache-read subset, `totalTokens` = `inputTokens` + `outputTokens` (counted once), `reasoningTokens` is 0 (no source evidence), `runs` counts API-request rows (shown as Requests), and `uncachedInputTokens` keeps the stored category recoverable. `costUsd` sums Claude Code's own estimates (never `LLM_PRICES`): null when none is known, a real 0 stays 0, and `costUnknownRequests`/`costPartial` mark partially unknown totals. Days are UTC event dates over a zero-filled window (`agentWindow(days, now)`); run/job/feature totals without a window are lifetime. A `projectId` filter uses the project of the **attributed run**; unattributed rows have an unknown project and appear only in the global scope (overall totals count them exactly once) and in `unattributed`.

### Showing agent usage

`GET /api/v1/usage/agents?days=30&projectId=<uuid>` (ordinary JWT or `gk_` key; `days` 1–365, `projectId` optional; the ingest token is rejected) returns `{ days, scope, projectId, totals, daily, byModel, byRepo, byFeature, unattributed }` with the totals above. `GET /api/v1/usage` is unchanged. `scope` is `project` when filtered (attributed runs of that project only; `unattributed` is then all zeros because those rows have no known project) and `global` otherwise (everything, unattributed included once). Aggregates only; no raw OTLP or content is exposed.

`GET /api/v1/jobs/:id` adds `agentUsage` (job lifetime) and an `agentUsage` on each run, and `GET /api/v1/features/:id` adds the feature's lifetime `agentUsage`. They are computed with one grouped query each for the loaded detail; job and feature lists and board cards are not enriched. Without telemetry they are zeros with `costUsd: null` (`runs: 0` means no telemetry received yet, which differs from recorded zero tokens).

In the UI, **Metrics** shows *Co-pilot usage* (always all projects, not filtered by the selected project) above *Agents (Claude Code)* for the last N **UTC days**, by default for the selected project, with a toggle to *All projects + unattributed*. It shows the four token categories (uncached input, cache read, cache creation, output), total tokens, Requests, estimated cost, a daily chart and per-model, per-repo and per-feature tables. The unattributed share is unattributed tokens / all tokens in the all-projects view (`–` when there are no tokens, `n/a` in a project view). **Job detail** (Runs tab) shows lifetime usage per attempt and in total; **feature detail** shows the feature's lifetime total. Run, job and feature totals are lifetime recorded usage, not limited to the metrics day window.

Cost is always labelled *estimated*: it is Claude Code's own figure, and under a subscription it is notional, not billing. An unknown cost is shown as `unavailable`, never `$0`; a partly known one as `$x+ (n requests unknown)`. "No telemetry received" (no rows) is shown differently from loading, an error, and real zero values.

## Lessons

Gilde collects candidate lessons hourly from two sources: the agent's `suggestedLesson` in its result block and review feedback from repository members
(owner, member or collaborator). PR retros are not collected: a retro is a report, and agents distil the useful part into `suggestedLesson`. The retro stays
on the run and is shown in the run and job detail. Older `retro` lesson sources remain valid.

Before retros stopped becoming candidates, they filled the candidate list. To reject those, run the operator CLI (idempotent). It moves candidate lessons whose
only sources are retros to `rejected` with an explanatory note, and never touches lessons with another source or in any other status. `--dry-run` only
prints the count and the ids.

```bash
pnpm --filter @gilde/api lesson:reject-retro-candidates [--dry-run]
# production
docker compose exec api node dist/cli/lesson-reject-retro-candidates.js [--dry-run]
```

## Updating resources (PUT)

Jobs, features, projects, repos and lessons are updated with `PUT` on the resource, which replaces its updatable fields as a whole. There are no `PATCH` routes, and a body that omits a key is answered with 400 and a zod issue for that key. A nullable field is a required key too: send `null` to clear it. Fields that are not listed (ids, `slug`, `fullName`, `paused`, status, manifest fields) cannot be changed this way and are ignored when sent.

| Route | Required keys |
|-------|---------------|
| `PUT /api/v1/jobs/:id` | `title`, `task`, `acceptanceCriteria`, `featureId` (`null` unlinks) |
| `PUT /api/v1/features/:id` | `title`, `spec`, `acceptanceCriteria` (`""` and `[]` are real values) |
| `PUT /api/v1/projects/:id` | `name`, `description` (nullable), `dailyRunLimit`, `maxAttempts`, `runTimeoutMinutes`, `retryOnChangesRequested`, `skillsLibrary`, `skillsLibraryRepoId` (nullable), `dailyBudgetUsd` and `weeklyBudgetUsd` (nullable, `0` is a limit), `budgetSoftPct` |
| `PUT /api/v1/repos/:id` | `defaultBranch`, `routineFireUrl` (nullable), `routineTokenEnv` (nullable), `maxConcurrentJobs` |
| `PUT /api/v1/lessons/:id` | `text`, `targetKind` (nullable), `targetRepoId` (nullable), `note` (nullable) |

State rules still apply to a full body: a job's content can only differ from the stored one in `triage` (a queued job accepts a new `featureId` with its content resent unchanged), and a feature can only be replaced while it is draft or active. Two people editing the same resource at the same time is last write wins: a complete body carries the values the client loaded, with no version check. Job dependencies keep their own `PUT /api/v1/jobs/:id/dependencies`. See [ADR 0008](docs/adr/0008-full-replacement-put-controllers-use-services-and-dtos.md).

## Specs

A spec is a versioned document per repo (`apps/api/src/spec/`). The repo, project and kebab-case `slug` never change, and the slug is unique per repo. Every save inserts an immutable `spec_versions` row with the body stored byte for byte (plus its SHA-256); rows are never updated, and Postgres triggers refuse updates and deletes of versions and approvals.

### Template

A body has exactly these six H2 headings, once each, in this order (fenced code is ignored when looking for structure):

```md
## Goal
## Context
## Behaviour
## Acceptance criteria
- AC-1: A concrete, checkable outcome.
## Out of scope
## Open questions
None
```

Every item under *Acceptance criteria* is `AC-<positive integer>: text` with unique ids and no unlabelled criteria. Ids are stable across versions: an id that left the latest version is retired and cannot return, new ids must exceed the highest id ever used, and surviving ids keep their number. A body that breaks these rules is rejected (400, with `issues`). *Open questions* is resolved when empty or only `None`; otherwise the version still saves, but it cannot be approved and the API lists the reasons.

### API

| Route | |
|-------|--|
| `GET /api/v1/projects/:id/specs` | list specs of a project |
| `POST /api/v1/projects/:id/specs` | create: `repoId`, `slug`, `title`, `body`, `expectedVersion: 0` (the repo must belong to the project) |
| `GET /api/v1/specs/:id` | detail with version history (newest first): parsed criteria, per-version `eligibility`, `approval` evidence and `recording`, plus the caller's `mayApprove` and `mayApproveReasons` |
| `POST /api/v1/specs/:id/versions` | save a new version: `title`, `body`, `expectedVersion`; the spec returns to `draft`, earlier approvals stay |
| `POST /api/v1/specs/:id/approve` | approve: `expectedVersion` |

The actor is always the authenticated user; bodies reject unknown keys, so an actor field is a 400. Writes need the `expectedVersion` the caller saw: a stale one is a 409. Anyone authenticated (including bots and API keys) may save drafts. Only a verified human may approve (the check in "Bot accounts"): API keys are refused (401), bots 403, and approving a version with open questions is a 422 with `reasons`.

### Recording

Approval commits, in one transaction, the approval audit row, the spec's `approved` state and one recording job in **triage** (never queued), created by the approving human, titled `Record spec <slug> v<n>`. Its task starts with the fetch/rebase line, names spec, version, approver and time, and carries the exact body between hash-named markers as data. Only `docs/specs/<slug>.md` and `docs/specs/README.md` may change. Approving the same version again changes nothing. Any failure rolls the whole approval back. Writes to one spec are serialised (a row lock on Postgres), and the audit rows are unique per version.

A newer approval looks at the newest recording that was not superseded:

- an unstarted **triage** job is reused in place for the new version, keeping its prerequisite;
- an unstarted **queued** job is cancelled through the job state machine and replaced by a new triage job (a dispatcher that claims it first wins; the job then counts as in flight);
- anything in flight, failed, or pinned by a feature is never touched: the new triage job depends on it, so recordings are written in order. A failed, rejected, parked or cancelled prerequisite stays an explicit blocker that a human resolves; nothing is bypassed or queued automatically.

The version's `recording` shows `state` (`triage`, `queued`, `in_flight`, `recorded`, `failed`, `superseded`), the job status and PR link, `dependsOnJobId`, and `supersededByRecordingId` once replaced. Old audit rows are never rewritten.

## Specs and planning

The co-pilot drafts specs and plans work from them; only a verified human approves. **Save is not approve.**

- **Save draft (co-pilot).** `draftSpec` creates a spec (`expectedVersion: 0`) or saves a new version (`expectedVersion` = the `currentVersion` it read with `getSpec`). It asks for confirmation first: the chat card says "Draft · not approved", loads the current version, shows an escaped line diff and the proposed text rendered as safe markdown, and **Save draft** stays disabled while that loads, fails or is stale. Cancelling writes nothing. The actor is the user of the request, never tool input. A confirmed save only ever produces a draft; the co-pilot has no approval tool, and approving stays on `POST /api/v1/specs/:id/approve` (JWT, persisted human). The Verkenner has no spec, draft or planning tool (its allowlist is tested). The Slack channels process has no approval UI, so a `draftSpec` or plan there never gets confirmed and nothing is written: no spec approval path exists outside the web app.
- **Plan from an approved version.** `planFeature` and `createPlannedFeature` take an optional `specId` plus `specApproval: { version, approvalId }`, the exact approved version and its approval record from `getSpec`. The version must be the spec's current `approvedVersion` in the same project, and its recording job must be able to merge (triage, queued, in flight or merged; a cancelled, rejected, parked, merged-without-work or superseded recording is a validation error). A newer draft does not make the approved version stale; a newer approval does (the old token is refused as superseded). Plans without `specId` behave as before.
- **One transaction.** `FeaturePlanService` (`apps/api/src/copilot/`) validates the token again inside the transaction, under the spec's write slot, so an approval or a new draft cannot slip in between the confirmation and the write. The feature, its spec pin, all jobs and all dependency edges use one entity manager and commit together or not at all; the jobs are created in `triage` as the confirming user and nothing is queued or started.
- **Pinning.** The feature keeps `spec_id`, `spec_version` and a `spec_pin` snapshot (exact body, SHA-256, approval, approver, recording id and job) that are never updated (Postgres refuses changes). `GET /api/v1/features/:id` returns it as `pinnedSpec`. Later drafts and approvals never repin it. The recording is marked pinned, so a newer approval can no longer replace or cancel it. Legacy and small standalone work stay unlinked (`pinnedSpec: null`).
- **Jobs get the spec context.** Every job of a linked plan depends on the pinned recording job (besides its own plan edges), so none runs before the spec file is merged. Its task starts with the fetch/rebase line, then the exact version, approval and recording identity, the file `docs/specs/<slug>.md` (and whether it is in this repo or another one), the SHA-256, and how to read the pinned version from Git history when `main` holds a newer recording.

### Browsing and approving in the web UI

**Specs** in the sidebar lists the selected project's specs (title, repo, draft/approved, newest and approved version). A spec page (`/specs/:id`, with `?project=` kept on every link) shows the version history, and `/specs/:id/versions/:n` opens a historical version. Each version shows its immutable body (safe markdown), acceptance criteria, a line diff against another version (the previous one by default), the approval evidence (approver, time, approval id, body SHA-256) or the reasons it cannot be approved yet (such as open questions), and its recording job with `StatusBadge` and pull request link when there is one.

- **Approve** only appears when the API says the caller may approve (`mayApprove`); the UI never infers it from a name, email or bot flag. For a permitted human it is disabled, with the server's reasons, when the visible version is ineligible, not the newest, or already approved. A click sends exactly the version on screen as `expectedVersion`: polling can reveal a newer version, but the page keeps showing (and sending) the one you opened until you choose the newest. Double clicks are ignored while a request runs. A 403 (not a verified human), 409 (the spec changed) or 422 (ineligible) is explained and offers a refresh; saving a draft never approves anything, and there is no co-pilot approval path.
- **Pinned version.** A feature planned from a spec shows *Pinned spec* on its overview, linking to the exact pinned version (`/specs/:id/versions/:n`), never the latest draft. Features without a spec look as before.

The web card, the markdown renderer (`components/safe-markdown.tsx`, `react-markdown` without HTML support: raw HTML is shown as text, images are not loaded, only http, https, mailto and relative links are links) and the diff (`components/text-diff-view.tsx`, `lib/text-diff.ts`) are shared primitives for the spec pages.

## Budgets

Estimated-USD budgets per UTC day and ISO week (Monday start). They **measure** recorded spend, **warn** through the notification outbox and **stop new automatic dispatch** at the hard limit (see "Enforcement" and "Budget notifications" below). Human use of Gilde is never blocked.

**Settings.** Each project has nullable `dailyBudgetUsd` and `weeklyBudgetUsd` (finite, `>= 0`; `null` clears a limit; `PUT /api/v1/projects/:id` replaces all settings, so the body always carries both limits and `budgetSoftPct`; `0` means hard immediately, even at zero spend) and `budgetSoftPct` (default 80, `> 0` and `<= 100`). Global limits come from the environment: `GLOBAL_DAILY_BUDGET_USD` and `GLOBAL_WEEKLY_BUDGET_USD` (unset or blank = unlimited; the global soft threshold is 80%). The environment is re-read on every evaluation, so a corrected value takes effect on the next pass without a restart.

**API.** `GET /api/v1/budget?projectId=<uuid>` (ordinary login or API key; read-only; `projectId` optional, 400 for a bad UUID, 404 for an unknown project) returns the global day/week status, the project's when `projectId` is given, every effective hard blocker (`blockers`, `hardBlocked`) and the recovery information. Each period has `startsAt` (inclusive) and `resetsAt` (exclusive), `spent` (sum of the known estimates), `pricedRows`/`totalRows`/`unpricedRows`, `pricing` (`empty`, `complete`, `partial`, `unknown`) and `incomplete`, `limit` and `percent` (both `null` without a limit; `percent` is also `null` for a limit of 0), `softPct`, `state` (`ok`, `soft`, `hard`) and a `reason`. Reaching a threshold exactly counts (`>=`); hard wins over soft. Costs are compared unrounded; round only for display. One clock reading is used per request.

**What counts.** Project budgets sum `agent_usage` rows attributed to one of the project's runs (through `job_runs.projectId`). Global budgets sum **every** `agent_usage` row exactly once, attributed or not, plus **every** `llm_usage` row (all kinds, co-pilot and background usage). The agent rows use the periods of `eventAt`, the co-pilot rows of `createdAt`. Nothing is recalculated: Claude Code's reported cost and the stored `LLM_PRICES` estimates are used as recorded.

**Caveats.** Dollars are *estimated*; with a subscription they are notional consumption, not a bill. Rows without a price add nothing to `spent` and are counted in `unpricedRows`; a period with only unpriced rows has `pricing: "unknown"` and is never a priced zero, and unpriced rows alone never cause a hard state. This is a recorded-spend guard, not a reservation system: telemetry arrives and is attributed with delay, and running jobs can overshoot a limit. GitHub Actions agent reviews are not metered unless they send telemetry.

**Invalid global configuration.** A set but invalid `GLOBAL_*_BUDGET_USD` (not a finite, non-negative number) never stops the API from starting and never throws out of the status call. A configuration error naming the variable (never its value) is logged, and only that global period reports `state: "hard"` with `reason.kind: "configError"` and `reason.variable`; its `limit` and `percent` are `null` (no invented number), while spend, unpriced counts and the period dates stay visible. It is a blocker for the global status and for every project's effective status, so new automatic dispatch must fail closed, while human API and chat use is unaffected. A period reset does not clear it: `recovery` is `"manual"` and `recoversAt` is `null` until the variable is corrected or removed; the next evaluation then recovers, subject to other blockers. With several hard blockers, `recoversAt` is the latest of their resets (`recovery: "reset"`).

### Enforcement

`DispatcherService` asks `BudgetService.status(projectId)` for live recorded spend before the first fire of every repo in a pass and again before every further fire in the same repo, so a hard limit reached during a pass is not hidden. At a hard project **or** global day **or** week limit the repo reports `reason: "budget"` and **nothing is fired**: no run or attempt is reserved, no job changes state, the execution port is not called and `paused`/`pausedReason` are never written. The report (`GET /api/v1/dispatch/status`, the board's dispatch strip) names every simultaneous blocker with scope, period, estimated spend, limit and reset in `budget.blockers`; `resetsAt` is the **latest** blocker reset (the earliest possible full recovery) and is `null` when a limit or configuration change is needed (`budget.recovery: "manual"`, for example a limit of 0 or an invalid `GLOBAL_*_BUDGET_USD`) or when the budget could not be read (`recovery: "unknown"`).

- Order of checks is unchanged: manual project/repo pause, routine, manifest, free slots and the daily run limit still win and report their own reason; the budget is checked after them, before jobs are selected. Dependencies and proposals still exclude jobs as before.
- `POST /api/v1/dispatch` (any logged-in user or API key) goes through the same gate; there is no manual bypass.
- There is no state to clear: every pass re-reads spend and limits, so a reset, a raised limit or a cleared limit resumes automatically. A manually paused project or repo stays paused.
- A budget **evaluation error never allows a new automatic fire** (fail closed): the repo reports `budget` with `budget.error: true`, the error is logged, and no `$0` status is invented. Already running jobs, CI and reconcile handling, telemetry ingest and attribution, the co-pilot, the API and the UI are unaffected, and so is human chat while the budget cannot be read.
- **This is a recorded-spend guard, not a reservation system.** Telemetry arrives with a delay, running jobs keep spending, and the co-pilot is never stopped, so spend can overshoot a limit. Unpriced rows add nothing to `spent`. **GitHub Actions agent reviews are not controlled or metered** by this feature unless they already send telemetry to the OTLP ingest.

### Budget notifications

`budget.soft` and `budget.hard` use the existing outbox (`notifications`) and the Slack worker of `apps/channels`. `BudgetAlertService` evaluates the global scope once and then every project with a configured limit every minute (a non-overlapping pass, projects in batches of 20), independent of queued work; the dispatcher also records a hard stop when it finds one. `GET /api/v1/budget` stays side-effect free. An occurrence is unique per scope (`global` or the project id), period (`day`/`week`), canonical UTC period start and kind: `budget.<kind>:<global|project id>:<day|week>:<period start ISO>`. The database unique key makes retries, restarts, concurrent evaluations, threshold oscillation and limit edits record each soft and each hard at most once per period; a period that is already hard when first seen records `budget.hard` without a made-up soft crossing, and hard wins over soft. A new period is a new occurrence. A period with an invalid global setting records a hard occurrence carrying the variable name (never its value). The row stores the structured facts in `budget` (scope, period, state, estimated spend, limit, percent, UTC start and reset, unpriced count, reason kind); nothing is marked delivered before the Slack worker acknowledges it, so the outbox keeps its at-least-once semantics (not a new exactly-once guarantee). Recording problems are logged and never change a stop decision.


### Budgets in the web UI

- **Project settings** (`/settings/projects/<id>`, tab Budget): daily and weekly estimated USD (blank sends `null` = no limit, `0` is an intentional immediate stop, anything that is not a plain number `>= 0` is rejected before sending) and the soft percentage (`> 0` and `<= 100`). Next to each field the current UTC period's estimated spend, unpriced status and reset are shown for the **route's** project; after saving, the project and the budget status are reloaded. Server validation issues appear at their own field. Global limits are read-only (environment).
- **Board banner**: below the page header, a warning for a soft and a danger notice for a hard period of the selected project or the global scope. The hard text, "Dispatch paused by budget until …", uses the API's `recoversAt` (the LATEST blocker reset) and lists every hard blocker; with `recovery: "manual"` it says a limit or configuration change is needed. It states that a manual pause is separate and that the time is not a promise. While loading nothing is shown, and a failed load says the status is unavailable. It links to the project settings (keeping `?project=`). The job counts, filters and the dispatch strip are unchanged and there are no per-card requests.
- **Metrics**: bars for the project and global current UTC day and week, always from `GET /api/v1/budget` (independent of the days and repo filters), with spent/limit, percent (the fill is clamped at 100, the numbers are not), state, unpriced rows and reset time. No limit, a zero limit, no usage, a priced zero and all-unpriced or partial totals are shown as distinct states.

**Verkenner.** The scout is implemented on main; it stops its native wakes and daily summaries at a hard global budget (see "Global budget gate" under Verkenner), so there is no open TODO. Project budgets do not gate it.

**Human co-pilot.** It is never blocked by a budget; the sidebar only shows a nonblocking global warning.

## Notifications

Gilde stores platform-neutral factory events for exactly one consumer process (`apps/channels`). This is deliberately simple: one row per event in `notifications`, with the delivery state on the same row. There is no consumer registration, subscription, per-destination table, claim, lease, fencing token, send-intent or "uncertain" state, and the API holds no platform credentials or routing. Run one consumer loop only.

**Event row.** `occurrenceKey` (database-unique, built by the producer from stable source identity, never from the clock or a row id), `kind`, `occurredAt`, `projectId`/`jobId`/`featureId`, `title`, `repos` (full names), `reason`, `prLinks` (`{ repo, number, url }`), plus delivery fields `status`, `attempts`, `nextRetryAt`, `lastError`, `deliveredAt`. Kinds: `job.awaiting_review`, `job.parked`, `job.approval_needed`, `revision.waiting`, `feature.ready_to_close`.

**Recording.** `NotificationService.recordQuietly(envelope | () => envelope)` does one insert after the caller's domain write succeeded. A unique-key conflict means "already recorded"; every other error, including a throwing envelope function, is caught and logged, so a notification problem never fails or rolls back the domain change. There are no transaction wrappers, event buses, source retries or historical reconstruction.

**Endpoints** (JWT or API key like every other route):

- `GET /api/v1/notifications?kinds=job.parked,revision.waiting&limit=20` returns `pending` rows and `failed` rows whose `nextRetryAt` is due, oldest first (`createdAt`, then `id`). `kinds` is a comma-separated list (default: all kinds); `limit` is 1-100 (default 20). Delivered, permanently failed and not-yet-due rows are never returned.
- `POST /api/v1/notifications/:id/delivered` marks the row `delivered` (terminal, idempotent; repeating it changes nothing).
- `POST /api/v1/notifications/:id/failed` with `{ "reason": string, "retryable"?: boolean, "retryAfterSeconds"?: 1..86400 }` sets `failed`, increments `attempts`, stores a redacted, 500-character `lastError`, and sets `nextRetryAt = now + retryAfterSeconds` (default 60). `retryable: false` is a permanent failure: `nextRetryAt` is null and the row is not polled again. On a `delivered` row it is a no-op that returns the row.
- Both POSTs return the notification (404 for an unknown id, 400 for a non-UUID id or invalid body). Timing is persisted, so a restart of either process keeps the backoff.

**Delivery transitions:** `pending` -> `delivered`; `pending`/`failed` -> `failed` (retry later or permanent); `failed` -> `delivered`; `delivered` never changes. The consumer picks backoff (`retryAfterSeconds`), so it can honour Slack's `Retry-After`.

**Trade-offs.** Capture is best effort: a crash or failed insert after a successful domain write loses that notification, and lost captures are not reconstructed. Delivery is at-least-once for recorded events: if the consumer crashes, or its acknowledgement is lost, after the platform accepted a post, the event is sent again (rare duplicate). Neither window has recovery machinery.
### Captured events and occurrence keys

`NotificationCaptureService` (`apps/api/src/notification/notification-capture.service.ts`) builds the envelopes. Each call sits right after the successful domain write in the existing service, reads whatever it needs itself, and goes through `recordQuietly`, so enrichment reads and the insert are both caught and logged; the original method returns the same result either way. Only a write that actually changed something captures: a conditional-update loser, a stale head or a job that already moved on records nothing. No transactions, locks or readiness table were added.

| Kind | Recorded after | Occurrence key |
| --- | --- | --- |
| `job.awaiting_review` | `ci_passed` moved the job into `awaiting_review` (`JobEventsService.workflowCompleted`, so webhook and reconciler) | `job.awaiting_review:<job>:a<attempts>:<head sha>` |
| `job.parked` | a `park` write landed: CI failure or reviewer send-back (`JobEventsService.retryOrParkJob`) or a failed fire (`DispatcherService.failJob`) | `job.parked:<job>:a<attempts>:<head sha or none>:<cause>`, cause `failure`, `sent_back` or `dispatch` |
| `job.approval_needed` | a failing gate on the job's current head set `needsApproval` on a job that is not finished | `job.approval_needed:<job>:a<attempts>:<head sha>` |
| `revision.waiting` | `ProposalService.record` saved a proposed revision | `revision.waiting:<source run>:<target job>:<digest of title, task, criteria, dependsOn and reason>` |
| `budget.soft` / `budget.hard` | `BudgetAlertService` (scheduled every minute, and the dispatcher at a hard stop) found a soft or hard period | `budget.<kind>:<global or project id>:<day or week>:<UTC period start>`; no job, PR or repo data |
| `feature.ready_to_close` | a check after a job merge, a job cancel, a job's feature change, a feature start or a feature reopen found `buildProgress(...).readyToClose` | `feature.ready_to_close:<feature>:<digest of the sorted ids of the counted, non-cancelled jobs>` |

- Replays (webhook redelivery, reconciler passes) hit the unique key and are ignored. A new attempt or a new head sha is a new occurrence. Clearing and re-setting the same gate on the same head, or reopening a feature with the same ready job set, does not notify again; a different ready job set does.
- Proposals are deleted and recreated when a PR body is re-parsed, so the revision UUID is not part of the key: an identical proposal deduplicates, an edit (or another run) notifies. The post links the proposing run's PR and names the target job and repo.
- Feature readiness is exactly `buildProgress`: the feature is `active`, at least one non-cancelled job, all of them merged. It is evaluated from current rows after the write, never on `GET`, and concurrent checks of the same set collapse on the key. Features are never closed and jobs never approved automatically.
- **Lost captures are not reconstructed.** If the process stops between the domain write and the insert, or the insert fails, that notification is gone; nothing re-scans history later.

### Lessons in dispatched jobs

When a job fires, Gilde looks up relevant lessons in the history index and adds them to the job payload as an optional `lessons` array
(`{ id, text, scope, status, relevance }`; `id` is the lesson id, `scope` is `project` or `repo`). The agent instructions tell agents that lessons are
advisory: they never override the task, acceptance criteria, repo instructions or safety rules.

- **What is eligible.** Only lessons that are approved, applying or applied (re-checked against the database at fire time, so a revoked lesson is
  not sent even if the index has not caught up), in the job's own project, and either project-wide or targeting the job's repo. Raw retros, reviews,
  other projects and personal co-pilot memory are never sent.
- **Query and bounds.** The query is the job title, task, acceptance criteria and the repo stacks (at most 2000 characters). Lessons below the
  relevance threshold are left out rather than filling a quota; duplicates are removed. At most 5 lessons, 800 characters each and 3000 in total.
  Environment: `DISPATCH_LESSONS_TOP_K` (default and maximum 5; `0` switches lessons off), `DISPATCH_LESSONS_MIN_SCORE` (0 to 1, default 0.5) and
  `DISPATCH_LESSONS_TIMEOUT_MS` (hard timeout, default 3000, at least 100).
- **Fail-open.** A timeout, rate limit, missing `OPENAI_API_KEY` or index, vector error or no match gives no lessons and one bounded (200 characters)
  warning in the API log. The job still fires: no failed run, no parked job, no repo pause and no extra attempt. Dispatch never embeds or indexes
  inline; it only reads what the history reconciliation already indexed.
- **Prompt size.** The limit is 60000 characters of the exact final text sent to the routine (instructions, separator, job line, JSON escaping and the
  `promptTrimmed` metadata included). While it is over, optional context is reduced in this order, re-rendering and stopping as soon as it fits:
  1. lessons, from the least relevant end;
  2. every downstream task capped at 1500 characters, then 400 (a cut task ends in `… (truncated; read the full job with its id if needed)`, within the cap);
  3. downstream task text left out (`task` key omitted; `jobId`, `title`, `acceptanceCriteria` and `dependsOn` stay);
  4. downstream jobs removed one at a time: unrelated feature siblings first, then transitive dependents, oldest first each;
  5. the feature spec capped at 4000, then 2000 characters.

  The agent instructions and the job's own task and criteria are never shortened. The payload gets a `promptTrimmed` field describing the real
  reductions (`lessonsRemoved`, `downstreamTaskCap` as a number or `title-only`, `downstreamRemoved`, `featureSpecCap`, and `downstreamOmitted` /
  the 8000-character spec and 4000-character task caps and 20-job cutoff that already applied when the context was built); unchanged fields are
  omitted, and so is `promptTrimmed` when nothing was trimmed.
- **Planning guard and parking.** A job's task plus all its criteria (`task.length + sum(criterion.length)`) may be at most 40000 characters, checked
  when a job is created or its task or criteria are edited, and by the co-pilot's `validateJob` and `planFeature` (naming the plan job). Exactly
  40000 is accepted. If a prompt is still over 60000 after every reduction, only that job is parked (reason: final size, size of task and criteria,
  limit); no run is created, nothing is sent, the attempt is given back and it uses no daily-run allowance or slot, so the repo's other queued jobs
  fire in the same pass. Repo configuration errors (missing routine URL or token variable, unreadable instructions file) still pause the repo, and a
  paused repo is never unpaused automatically.
- **Preview.** `GET /api/v1/jobs/:id/prompt` returns `text`, `instructionsVersion`, `length`, `limit` and `trimmed` from the same prepared prompt a
  fire sends, with the same selection of lessons. It fires nothing and changes no state, and it still returns an over-limit text so it can be inspected
  (a fire refuses it). The job detail Prompt tab shows the size against the limit, an over-limit warning and what was trimmed. Continued PRs get lessons too.

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
