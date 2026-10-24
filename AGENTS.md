# Gilde — agent guide

Gilde is the control plane of an AI factory: it queues coding jobs, fires Claude Code
routines, tracks their PRs via GitHub webhooks, and records review feedback.
You are probably one of those agents, working on Gilde itself.

## Repository layout
pnpm workspace (`pnpm-workspace.yaml`: `apps/*`, `packages/*`).

- `apps/api/` — the NestJS API (`@gilde/api`), ESM (`"type": "module"`)
  - `src/main.ts` — bootstrap; global prefix `/api`
  - `src/app.module.ts` — root module, TypeORM config (better-sqlite3 locally)
  - `test/` — e2e tests (`*.e2e-spec.ts`)
- `packages/` — shared packages (none yet)

## Commands
Run from the repo root unless noted.
- Install: `pnpm install`
- Test everything: `pnpm test` (must pass before you open a PR)
- Build everything: `pnpm build`
- API only: `pnpm --filter @gilde/api test` · `... build` · `... lint` (oxlint) · `... test:e2e`
- Run the API locally: `pnpm dev` (port 4100 by default)

## API domains (`apps/api/src/`)
One NestJS module per domain:
- `project/` — products; policies like daily run limit, max attempts, pause
- `repo/` — GitHub repos in a project; test command, routine, concurrency
- `job/` — units of work; `job-state.ts` is the state machine
- `health/` — `GET /api/health`, returns `{ status, checks }`, 503 when the DB is down
- `common/` — shared pipes and helpers (zod validation, db errors)

Each domain has: `*.entity.ts`, `*.dto.ts` (zod), `*.mapper.ts`, `*.service.ts`, `*.controller.ts`, `*.module.ts`.
Unit tests live next to the code as `*.spec.ts` (vitest, globals enabled).

## Routes
- Global prefix `/api` is set in `main.ts`; controllers declare the rest.
- Domain controllers are versioned: `@Controller('/v1/...')` → `/api/v1/...`.
- `health` is unversioned: `/api/health`.
- Before adding an endpoint, check whether one already exists for the same purpose.

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
- If the task conflicts with existing code or is ambiguous, don't guess: report it as `blocked` and explain.
- Add or update tests for behaviour you change.
- Do not modify `.github/`, `AGENTS.md`, `CLAUDE.md`, or existing migrations unless the task says so.
- Do not add dependencies unless the task needs them; mention any new one in the PR.
- Never commit secrets or `.env` files.
