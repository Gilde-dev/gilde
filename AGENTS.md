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
- `apps/web/` — the Next.js (App Router) web UI (`@gilde/web`), Tailwind + shadcn-style components in `components/ui`
  - `lib/api.ts` — typed fetch client and response types (mirror the API DTOs); base URL from `NEXT_PUBLIC_GILDE_API` (default `http://localhost:4100/api`)
  - `lib/use-polling.ts` — `usePolling(fn, intervalMs)`; no data-fetching library, go through these two files
  - pages: job board (`/`), `/metrics`, `/lessons`; tests are `*.spec.ts(x)` (vitest + jsdom + Testing Library)
- `packages/` — shared packages (none yet)
- `.gilde.json` — Gilde manifest: stacks, test command, and which gildeboek skills this repo gets

## Commands
Run from the repo root unless noted.
- Install: `pnpm install`
- Test everything: `pnpm test` (must pass before you open a PR)
- Build everything: `pnpm build`
- API only: `pnpm --filter @gilde/api test` · `... build` · `... lint` (oxlint) · `... test:e2e`
- Run the API locally: `pnpm dev` (port 4100 by default)
- Web only: `pnpm --filter @gilde/web dev` (port 3000) · `... build` · `... test`
- The API allows CORS from `WEB_ORIGIN` (default `http://localhost:3000`)

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
- Entities follow the `typeorm-snake-case-columns` skill (`.claude/skills/`): snake_case table and column names, camelCase TypeScript fields.
- No `.default()` in schemas that get `.partial()`; rely on entity defaults.
- Throw Nest HTTP exceptions (`NotFoundException`, `ConflictException`), never let TypeORM errors leak.
- Job status changes only through the state machine in `job/job-state.ts`.

## Rules for agents
- Make the smallest change that satisfies the task and its acceptance criteria.
- If the task conflicts with existing code or is ambiguous, don't guess: report it as `blocked` and explain.
- Add or update tests for behaviour you change.
- Do not modify `.github/`, `.claude/`, `.gilde.json`, `AGENTS.md`, `CLAUDE.md`, or existing migrations unless the task says so.
- Skills in `.claude/skills/` with a `managed-by: gildeboek@…` frontmatter line are synced from Gilde-dev/gildeboek; never edit them here. Skills without that line belong to this repo.
- Do not add dependencies unless the task needs them; mention any new one in the PR.
- Never commit secrets or `.env` files.
