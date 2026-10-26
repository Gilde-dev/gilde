# Gilde

Control plane of an AI factory. See `AGENTS.md` for the repository layout and commands.

## Local development

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts the API (port 4100), the web UI (port 3000) and the channels process together with prefixed output; Ctrl+C stops all. If one app exits (channels exits with code 0 without Slack credentials), the others keep running. To start a single app use `pnpm dev:api`, `pnpm dev:web` or `pnpm dev:channels`.

Changes to source files reload automatically. Channels also restarts when its `.env` changes; for the API, restart `pnpm dev` after changing `.env`. Run `pnpm install` after a pull that changes dependencies.

## Postgres

By default the API uses SQLite (`db.sqlite`). To use Postgres instead:

1. Start Postgres: `docker compose up -d`
2. Set `DATABASE_URL=postgres://gilde:gilde@localhost:5432/gilde` (see `apps/api/.env.example`) and run `pnpm dev`.

The compose service uses the `pgvector/pgvector:pg16` image, which has the pgvector extension available. Mastra's `PgVector` runs
`CREATE EXTENSION IF NOT EXISTS vector` itself when it creates an index, so no init script is needed. **Existing Postgres setups:**
switching the compose image keeps the data volume (same major version), but run `docker compose pull && docker compose up -d` to
recreate the container. A self-managed Postgres needs the pgvector package installed (`CREATE EXTENSION` needs the right to create
extensions, or run `CREATE EXTENSION vector;` once as a superuser). Without pgvector, only vector features fail (see Degraded operation);
the rest of the API is unaffected. Without `DATABASE_URL`, co-pilot memory and vectors live in the LibSQL file `mastra.db`
(gitignored, override with `MASTRA_DB_URL`, e.g. `file:/data/mastra.db`); keep that file on persistent storage to keep memory across restarts.

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
