# Gilde

Control plane of an AI factory. See `AGENTS.md` for the repository layout and commands.

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
