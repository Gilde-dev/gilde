# Gilde — agent guide

Gilde is the control plane of an AI factory: it queues coding jobs, fires Claude Code
routines, tracks their PRs via GitHub webhooks, and records review feedback.
You are probably one of those agents, working on Gilde itself.

## Commands
- Install: `pnpm install`
- Test: `pnpm test` (must pass before you open a PR)
- Build/typecheck: `pnpm build`
- Run locally: `pnpm start:dev` (uses better-sqlite3)

## Structure
One NestJS module per domain under `src/`:
- `project/` — products; policies like daily run limit, max attempts, pause
- `repo/` — GitHub repos in a project; test command, routine, concurrency
- `job/` — units of work; `job-state.ts` is the state machine
- `common/` — shared pipes and helpers (zod validation, db errors)

Each domain has: `*.entity.ts`, `*.dto.ts` (zod), `*.mapper.ts`, `*.service.ts`, `*.controller.ts`, `*.module.ts`.

## Conventions
- ESM: relative imports end in `.js`.
- DTOs are zod schemas; types via `z.infer`. Validate with `ZodValidationPipe`.
- Import zod-inferred types with `import type`; import injected classes normally (DI needs them).
- Services return DTOs via the mapper, never entities, except methods documented as internal.
- Entity column types must work on both SQLite and Postgres: `simple-json`, `simple-enum`, no `jsonb`/`timestamptz`.
- No `.default()` in schemas that get `.partial()`; rely on entity defaults.
- Throw Nest HTTP exceptions (`NotFoundException`, `ConflictException`), never let TypeORM errors leak.
- Job status changes only through the state machine in `job/job-state.ts`.

## Rules for agents
- Make the smallest change that satisfies the task and its acceptance criteria.
- Add or update tests for behaviour you change.
- Do not modify `.github/`, `AGENTS.md`, `CLAUDE.md`, or existing migrations unless the task says so.
- Do not add dependencies unless the task needs them; mention any new one in the PR.
- Never commit secrets or `.env` files.