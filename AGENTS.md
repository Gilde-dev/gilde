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
  - `lib/api.ts` — typed fetch client and response types (mirror the API DTOs); calls `/api/gilde`, a server-side proxy (`app/api/gilde/[...path]/route.ts`) that adds the token from the httpOnly `gilde_session` cookie and forwards to `GILDE_API_URL` (server-only, default `http://localhost:4100/api`). The browser must never read or store the token. `middleware.ts` redirects to `/login` without the cookie. The proxy streams responses (`text/event-stream` is not buffered)
  - `lib/use-polling.ts` — `usePolling(fn, intervalMs)`; no data-fetching library, go through these two files
  - pages: job board (`/`), `/features`, `/metrics`, `/lessons`; tests are `*.spec.ts(x)` (vitest + jsdom + Testing Library)
- `apps/channels/` — a separate Node process (`@gilde/channels`) that runs the co-pilot in chat platforms (Slack first) with CopilotKit Channels, over AG-UI against `/api/v1/mastra`, authenticated with an API key of a bot user (`GILDE_API_KEY`). Platform credentials (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`) live only in its env. Adapters are listed in `src/adapters.ts`; see its README
- `packages/` — shared packages (none yet)
- `docs/adr/` — Architecture Decision Records, one per decision, index in docs/adr/README.md; see the write-adr skill
- `.gilde.json` — Gilde manifest: stacks, test commands, and which gildeboek skills this repo gets

## Commands
Run from the repo root unless noted.
- Install: `pnpm install` — run it first in a fresh session; tests (web especially) fail to start without dependencies
- Test everything: `pnpm test` (unit tests)
- CI runs the build, unit tests and e2e tests per changed app on PRs and everything on main; agents still run the full `pnpm build`, `pnpm test` and `pnpm --filter @gilde/api test:e2e` locally before opening a PR.
- Build everything: `pnpm build`
- API only: `pnpm --filter @gilde/api test` · `... build` · `... lint` (oxlint) · `... test:e2e`
- Run the API locally: `pnpm dev` (port 4100 by default)
- Web only: `pnpm --filter @gilde/web dev` (port 3000) · `... build` · `... test`
- The API allows CORS from `WEB_ORIGIN` (default `http://localhost:3000`)

## API domains (`apps/api/src/`)
One NestJS module per domain:
- `user/` — users (name, email, argon2id password hash); created with the `user:create` CLI (`pnpm --filter @gilde/api user:create --email <email> --name <name>`)
- `auth/` — `POST /api/v1/auth/login` (passport-local, throttled 5/min per IP) issues a JWT; `GET /api/v1/auth/me`; the global `JwtAuthGuard`, which accepts a JWT or an API key (`Authorization: Bearer gk_...`); both end up as `req.user`. Env: `JWT_SECRET` (≥ 32 chars), `JWT_EXPIRES_IN`, `AUTH_ENABLED`
- `api-key/` — `api_keys` (`gk_<prefix>_<secret>`, sha256 hash stored, shown once on creation); `POST/GET /api/v1/api-keys`, `DELETE /api/v1/api-keys/:id` for the current user; CLI `pnpm --filter @gilde/api apikey:create --email <email> --name <name>`; the web page is `/settings/api-keys`
- `project/` — products; policies like daily run limit, max attempts, run timeout, retry on changes requested, pause
- `repo/` — GitHub repos in a project; test command, routine fire URL and token env var name, concurrency, pause
- `job/` — units of work; `job-state.ts` is the state machine (triage → queued → dispatched → pr_open → awaiting_review → merged, plus rejected/parked/cancelled); `job-dependency.entity.ts` for dependencies; `job-events.service.ts` applies GitHub events to jobs
- `feature/` — groups of jobs across a project's repos; its own state machine in `feature-state.ts`
- `run/` — one row per attempt (`job_runs`): session, parsed PR result and retro, CI conclusion
- `dispatch/` — fires queued jobs every minute (and `POST /api/v1/dispatch`), respecting pause, concurrency, the daily limit and dependencies
- `execution/` — `ExecutionPort` and the Claude Code routine adapter that fires jobs
- `webhook/` — `POST /api/webhooks/github` (HMAC-verified): pull request, workflow run, review and comment events; `pr-body.ts` parses the agent's PR body
- `reconcile/` — every 5 minutes (and `POST /api/v1/reconcile`) recovers job state from GitHub when webhooks were missed
- `github/` — `GitHubPort` with a read-only REST adapter (`GITHUB_TOKEN`)
- `feedback/` — reviews and review comments on agent PRs
- `lesson/` — lessons collected hourly from runs and feedback; review, merge and apply
- `metrics/` — `GET /api/v1/metrics`
- `health/` — `GET /api/health`, returns `{ status, checks }`, 503 when the DB is down
- `copilot/` — the co-pilot: a Mastra agent (`gilde`) built in a Nest provider (`copilot.mastra.ts`) so its tools get the services by injection; `@mastra/nestjs` is mounted under `/api/v1/mastra` (RouterModule) and the CopilotKit/AG-UI route is `/api/v1/mastra/copilotkit`. Behind the global JWT guard; `CopilotContextInterceptor` puts `req.user` and the memory resourceId (the user id) into the Mastra request context on every Mastra route. Tools are in `copilot.tools.ts` (read-only, call services, return DTOs). `GET /api/v1/copilot/status` returns `{ enabled, model }`. Env: `OPENAI_API_KEY` and `COPILOT_MODEL` (`openai/<model>`, no default); without them the routes answer 503 and the API still starts. Memory: Postgres on `DATABASE_URL`, otherwise `mastra.db` (gitignored)
- Verkenner (the scout, in `copilot/verkenner.*`): an opt-in, unattended second Mastra agent (id `verkenner`) in the same Mastra instance and storage as `gilde`. Env `SCOUT_ENABLED=true`, `SCOUT_USER_EMAIL` (an existing bot user), `SCOUT_MODEL` (fallback `COPILOT_MODEL`); it is off, and the API still starts, otherwise. It has read tools and its notification inbox only, thread `verkenner:<projectId>` under the bot user, and the project comes from a server-issued binding, never from tool input. It is refused on every Mastra HTTP route. Verified signal APIs: `docs/verkenner-signals.md`; setup: README "Verkenner"
- `common/` — shared pipes and helpers (zod validation, db errors)

Each domain has: `*.entity.ts`, `*.dto.ts` (zod), `*.mapper.ts`, `*.service.ts`, `*.controller.ts`, `*.module.ts`.
Unit tests live next to the code as `*.spec.ts` (vitest, globals enabled).

## Web app (`apps/web/`)
- Next.js 15 App Router, React 19. Pages (`app/**/page.tsx`) stay thin and render one view from `components/` (e.g. `app/metrics/page.tsx` → `MetricsView`).
- App shell: every page except `/login` lives in `app/(app)/` and renders inside `AppShell` (`components/app-shell.tsx`, from `app/(app)/layout.tsx`). Desktop: a 240px sidebar (logo mark + Gilde, project dropdown, icon navigation with a Proposals badge for pending proposals and a Board badge, repos, Settings group, `UserMenu` with avatar/name/email/theme/log out) that collapses to a 64px icon rail; the choice is stored in localStorage (`SIDEBAR_STORAGE_KEY`, read after mount so SSR matches) and the rail keeps labels as `sr-only` text plus `title` tooltips and `aria-current`. Below `md` the same sidebar is a Radix drawer that is always expanded and independent of the rail. The content is one `<main>` panel (`rounded-xl`, bordered) inset 12px on the page background, with a top bar holding the menu/collapse button and a breadcrumb. Views render only their own header and content, never navigation or a `<main>`. The Board badge counts queued/dispatched/pr_open/awaiting_review jobs in the loaded list (`api.listJobs(projectId)`, at most 200), not the project's history; it is absent while loading or on error.
- The selected project comes from `useProject` (`lib/use-project.ts`: `{ projects, project, projectId, setProjectId }`), never from a page-local select. `?project=` is the source of truth, then the last choice in localStorage, then the first project. Keep `?project=` on in-app links (`withProject`), and show `NoProjects` when there is no project.
- Views and interactive components are client components (`'use client'`) in `components/`: kebab-case files, named exports. Shared primitives (button, badge, dialog) are in `components/ui/`. Import with the `@/` alias; merge classes with `cn` from `lib/utils.ts`.
- All API calls go through the `api` object in `lib/api.ts`; failures throw `ApiError` (with zod `issues` for form fields). Keep its types and status lists in sync with the API DTOs you change. Poll with `usePolling`; no data-fetching or state library.
- Design system (cool neutrals, amethyst/indigo brand): `app/globals.css` holds CSS primitives as space-separated sRGB channels (neutral stops N0…N1000 per theme with the exact supplied hex values, amethyst-500 `#8143D7`, indigo-600 `#4029D1`, eggplant-800 `#000079`, lighter `-300` dark variants, and green/red/yellow/blue 50/500/700) and semantic tokens that only alias them; `tailwind.config.ts` exposes the semantics as `rgb(var(--x) / <alpha-value>)` so opacity modifiers work. Components use the semantic classes only: `background` (page), `surface` (panel), `sidebar`, `lane`, `foreground`, `card`, `popover`, `muted`(+`-foreground`), `border`(+`border-subtle`), `input`, `ring` (indigo), `primary` (+ `bg-primary-gradient`, amethyst to indigo), `accent`, and the semantic `success`, `warning`, `danger`, `info`, `running` (indigo, how a dispatched job is shown) and `pr` (violet), each with `-foreground`, `-soft` (badge background) and `-solid` (dots). Never use Tailwind palette colours (including primitive names like `indigo-600`) or `bg-white`/`text-black` in `components/` (ui included), `app/` or `lib/`; `components/design-tokens.spec.ts` fails on them. The same spec checks the exact primitives, bans Fraunces/Inter and lucide rendering outside `ui/icon.tsx`, and recomputes the WCAG contrast of the pairs documented at the top of `globals.css` (main/muted text on every surface, badge pairs, gradient text at its worst point); after changing a colour, recompute that table. Light: page N100, panel and cards N0, sidebar N50; dark: page N25, panel N50, cards N100. Light has one shadow (`shadow-sm`, N900 at 6%); dark has none and uses borders and surface steps.
- Type and sizes are real pixels: the root font size is 16px (it used to be 14px), so spacing is the 4px Tailwind scale (`p-1` = 4px). Font sizes: `text-display-xl` 40/52, `-lg` 32/44, `-md` 28/36, `-sm` 24/32, `text-lg` 17/24, `text-md` 15/20, `text-sm` 13/18, `text-label` 12/16 medium. Page titles are `text-display-sm`, card titles `text-md font-semibold`, body `text-md`, metadata `text-sm text-muted-foreground`. Radii: `rounded-md` 10px (inputs, buttons), `rounded-lg` 12px (cards), `rounded-xl` 16px (lanes, panels, dialogs), `rounded-full` (tabs, badges). `cn` (`lib/utils.ts`) knows the custom font sizes; a new size class must be added there too. Fonts via `next/font/google` as CSS variables: Figtree for all text and headings (`font-sans`; `font-serif` is a temporary alias for it, don't use it in new code) and JetBrains Mono for ids, SHAs, branches, repos and code (`font-mono`).
- Icons: `lucide-react` is the only icon library, and the only place that renders its icons is `components/ui/icon.tsx` (`<Icon icon={Inbox} size={16} label?>`; sizes 14, 16, 20; decorative and `aria-hidden` unless a `label` is given). Components hand a glyph to `icon` props (Button, Badge, EmptyState) and never render lucide components themselves. Primitives in `components/ui/`: button (primary gradient, secondary, outline, ghost, danger; sm/md; optional `icon`), badge (neutral, accent, success, warning, danger, info, running, pr; optional `dot` or `icon`), dialog, input, textarea, select, label, field (label + control + hint + zod issue for its `path` from `ApiError`), card, tabs (segmented pills, roving tabindex), empty-state (optional icon), page-header (title, description, actions), skeleton, avatar (initials, sizes 20/24/32, system fallback) and stat-card (label, value, optional delta/hint; pass real data only). Show job and feature statuses with `StatusBadge` (`components/status-badge.tsx`), never raw status text: triage neutral, queued blue, dispatched shown as "Running" (indigo), pr_open violet, awaiting_review yellow, merged green, rejected and parked red, cancelled neutral; feature draft neutral, active indigo, done green, cancelled neutral. Theme: `lib/theme.ts` (Light/Dark/System in the user menu, stored in localStorage, applied by an inline script in `app/layout.tsx` before paint). The CopilotKit sidebar is themed through `--copilot-kit-*` variables in `globals.css`.
- Board (`dashboard.tsx`, `board.tsx`, `job-card.tsx`): `Dashboard` fetches one unfiltered `api.listJobs(projectId)` through `usePolling` and derives everything from it; the creator filter ("Me", matched against `api.me`) and feature filter only change the displayed subset, never the counts and never the request (no `createdBy=me`). The four stat cards come from `boardStats` in `lib/job-stats.ts`: In progress = dispatched + pr_open; Awaiting review = awaiting_review; Triage (waiting for you) = triage; Needs attention = parked OR needsApproval OR failedDependency (a job counts once per card; cards may overlap). They cover the loaded list only (up to 200) and say so; loading shows `…`, a failed load `–`, and only a loaded list shows a real `0`. No time-based statistics or proxies. Board states are explicit: loading (skeleton), error, a genuinely empty project (one icon `EmptyState` with a working New job action, via the optional `onNewJob`), and filters that match nothing (with a reset), then the lanes (`lib/lanes.ts` grouping; light soft tint, dark raised `lane` surface; Done collapsed; Triage bulk queue). Cards use list-returned fields only (status/feature badge, mono repo, title, two-line task, PR, branch, attempts, age, creator avatar, blockers, approval, parked reason, `JobActions`); no CI, run or feedback counts and no per-card `api.getJob`. `getJob` is only for explicitly opened details (modal, `?job=` deep link, detail pages). Nested links, checkboxes and action buttons must not open the card; the card opens on click, Enter and Space.
- Job-status logic lives in `lib/lanes.ts` (board columns) and `lib/job-actions.ts` (which actions a status allows); update both when job statuses or transitions change.
- Styling is Tailwind utility classes; no extra UI or chart libraries, except CopilotKit (`@copilotkit/react-core`, `@copilotkit/react-ui`) for the co-pilot sidebar: `components/copilot-provider.tsx` wraps the app in `app/layout.tsx` (not on `/login`), talks to `/api/gilde/v1/mastra/copilotkit` and shows a note when `GET /v1/copilot/status` says disabled. Share page context with `CopilotPageContext`.
- Tests: `*.spec.tsx` next to the component (Testing Library), shared test data in `*.fixture.ts`.

## Routes
- Global prefix `/api` is set in `main.ts`; controllers declare the rest.
- Domain controllers are versioned: `@Controller('/v1/...')` → `/api/v1/...`.
- `health` and the GitHub webhook are unversioned: `/api/health`, `/api/webhooks/github`.
- Before adding an endpoint, check whether one already exists for the same purpose.

## Conventions
- ESM: relative imports end in `.js`.
- DTOs are zod schemas; types via `z.infer`. Validate with `ZodValidationPipe`.
- Import zod-inferred types with `import type`; import injected classes normally (DI needs them).
- Services return DTOs via the mapper, never entities, except methods documented as internal.
- Entity column types must work on both SQLite and Postgres: `simple-json`, `simple-enum`, no `jsonb`/`timestamptz`.
- Entity changes need a Postgres migration (`pnpm --filter @gilde/api migration:generate <Name>`, then commit it from `apps/api/src/migrations/`); Postgres never synchronizes, SQLite uses `synchronize` locally.
- Entities follow the `typeorm-snake-case-columns` skill (`.claude/skills/`): snake_case table and column names, camelCase TypeScript fields.
- No `.default()` in schemas that get `.partial()`; rely on entity defaults.
- Throw Nest HTTP exceptions (`NotFoundException`, `ConflictException`), never let TypeORM errors leak.
- Every route requires a JWT unless marked `@Public()` (from `common/`). Only mark routes public that authenticate in another way (like the webhook signature) or must be reachable without login.
- e2e tests: create an authenticated agent with `authedAgent(app)` from `test/helpers/auth.ts`; don't log in per test (login is throttled).
- Job status changes only through the state machine in `job/job-state.ts`.
- Co-pilot tools call existing services and return their DTOs; never query repositories or call the HTTP API from a tool. A tool of the human co-pilot that changes state must ask the user for confirmation first (`requireApproval`); the one exception is the Verkenner scout's bounded triage-only `suggestJob` (ADR 0007). The acting user comes from the Mastra request context (`copilotUser`), never from tool input.
- Keep routes of the co-pilot under `/api/v1/mastra`; Mastra's catch-all controller must not shadow other routes.

## Rules for agents
- Make the smallest change that satisfies the task and its acceptance criteria.
- If the task conflicts with existing code or is ambiguous, don't guess: report it as `blocked` and explain.
- Add or update tests for behaviour you change.
- Do not modify `.github/`, `.claude/`, `.gilde.json`, `AGENTS.md`, `CLAUDE.md`, `docs/agent-instructions.md`, or existing migrations unless the task says so.
- Skills in `.claude/skills/` with a `managed-by: gildeboek@…` frontmatter line are synced from Gilde-dev/gildeboek; never edit them here. Skills without that line belong to this repo.
- Follow accepted ADRs in docs/adr/; departing from one needs a new ADR that supersedes it, and only when the task asks for it.
- Do not add dependencies unless the task needs them; mention any new one in the PR.
- Never commit secrets or `.env` files.
