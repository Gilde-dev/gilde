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
