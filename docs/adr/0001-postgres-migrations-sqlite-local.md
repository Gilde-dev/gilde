# 0001. Postgres with migrations in production, SQLite with synchronize locally

- **Status:** Accepted
- **Date:** 2026-10-26
- **Related:** PR #73 (commit 5eecbec, introduced migrations), PR #77 (commit 0b5ccc5, uuid references); recorded retrospectively

## Context

The API uses TypeORM. The first database setup (PR #37, merged 2026-10-25) was `apps/api/src/database.config.ts` with SQLite and `synchronize`, which needs no setup for local development and tests. A production server needs a real database and a schema that changes in a controlled way: `synchronize` on a live database can alter or drop columns without review. The co-pilot memory (ADR 0004) also wants Postgres with pgvector.

This record is retrospective. The git history shows what changed (PR #73 added `InitialSchema` and switched Postgres to migrations) but no written discussion of options, so the alternatives below are comparisons made now, not documented deliberations.

## Decision

- When `DATABASE_URL` starts with `postgres://` or `postgresql://` (`isPostgresUrl` in `apps/api/src/database.config.ts`), the API uses Postgres with `synchronize: false` and `migrationsRun: true`. It applies the compiled migrations (`MIGRATIONS_GLOB`, `./migrations/*.js` resolved relative to the module so it works from `dist/`) on startup.
- Without such a URL, the API falls back to `better-sqlite3` with file `db.sqlite` and `synchronize: true`. No migrations run there.
- Every entity change needs a Postgres migration in `apps/api/src/migrations/`, generated with `pnpm --filter @gilde/api migration:generate <Name>` (also stated in `AGENTS.md`). Existing migrations are not edited. Today there are two: `InitialSchema` (1793001381370) and `UuidReferenceColumns` (1793008515424).
- Entity column types must work on both databases (`simple-json`, `simple-enum`, no `jsonb`/`timestamptz`).
- Row-reference columns use `uuid`, because every id is a uuid. `UuidReferenceColumns` exists because reference columns (for example `jobs.repo_id`, `feedback.job_id`) had been created as varchar. SQLite accepted that, but Postgres rejected joins and comparisons with `operator does not exist: uuid = character varying`, and most list endpoints returned 500 (commit message of 0b5ccc5). `apps/api/src/entity-id-types.spec.ts` enforces the convention: it builds TypeORM metadata for all `*.entity.ts` files and fails when a column whose name ends in `_id` or `_by` is not `uuid`. Columns that hold external ids (GitHub, Claude sessions, Mastra thread, history source) are listed in its `EXTERNAL_IDS` allow-list. The test checks column types in entity metadata only; it does not run against a Postgres server.

## Consequences

- Positive: local development and unit tests need no database server. Production schema changes are reviewed, versioned SQL and apply automatically on API start. The uuid convention is enforced by a unit test, so the SQLite/Postgres gap that caused the 500s fails in CI instead.
- Negative: two engines means SQLite can hide Postgres-only errors; only the type convention is covered by the unit test, not behaviour in general. Each entity change needs a generated migration that must be reviewed. Migrations run at startup, so a failing migration stops the API from booting.
- Follow-up: the Mastra tables for co-pilot memory are not part of these migrations; Mastra creates them itself (see ADR 0004). A one-off SQLite-to-Postgres copy CLI (`apps/api/src/cli/copy-sqlite-to-postgres.ts`) came with PR #73 for moving existing data.

## Alternatives considered

Retrospective comparisons; the history does not show them being weighed.

- **`synchronize` on Postgres too** — simplest, but unreviewed schema changes against production data. PR #73 moved away from it.
- **Postgres everywhere, including local development and tests** — removes the engine gap, but requires a running server (the repo ships a compose file for it as an option) for every contributor and CI job.
- **SQLite in production** — no extra service, but the co-pilot memory and vector search use Postgres/pgvector in production (ADR 0004).
