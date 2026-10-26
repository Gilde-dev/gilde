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

`AgentUsageService` aggregates in SQL with joins (no list caps, no per-item queries): `totals`, `unattributed`, `forRuns`, `forJobs`, `forFeatures`, `byRepo`, `byFeature`, `byModel` and `byDay`. Keys follow the co-pilot's `UsageTotalsDto`, with `cacheCreationTokens` added: `inputTokens` = uncached + cache read + cache creation, `cachedInputTokens` is the cache-read subset, `totalTokens` = `inputTokens` + `outputTokens` (counted once), `reasoningTokens` is 0 (no source evidence), `runs` counts API-request rows (shown as Requests), and `uncachedInputTokens` keeps the stored category recoverable. `costUsd` sums Claude Code's own estimates (never `LLM_PRICES`): null when none is known, a real 0 stays 0, and `costUnknownRequests`/`costPartial` mark partially unknown totals. Days are UTC event dates over a zero-filled window (`agentWindow(days, now)`); run/job/feature totals without a window are lifetime. A `projectId` filter uses the project of the **attributed run**; unattributed rows have an unknown project and appear only in the global scope (overall totals count them exactly once) and in `unattributed`. The HTTP read API and UI come in the next job.

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
- **Prompt size.** The prompt limit (60000 characters) still applies to the whole text. If lessons would push it over, the least relevant ones are dropped
  until it fits; instructions, task and criteria are never shortened.
- **Preview.** `GET /api/v1/jobs/:id/prompt` uses the same selection and shows the lessons a fire would send. It fires nothing and changes no state.
  Continued PRs get lessons too.

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
