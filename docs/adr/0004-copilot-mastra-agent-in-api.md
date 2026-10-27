# 0004. Run the co-pilot as a Mastra agent in the API, with CopilotKit over AG-UI

- **Status:** Accepted; its approval clause is superseded for the Verkenner scout only by [0007](0007-verkenner-scout-may-create-triage-jobs.md)
- **Date:** 2026-10-25
- **Related:** PR #48 (commit 1c07058, co-pilot base), PR #49 (commit 5f2345e, planning and approval), PR #59 (commit dd61769, memory), PR #84 (commit 43eeeae, createJob); recorded retrospectively

## Context

Gilde wants a co-pilot that answers questions about projects, jobs, features and lessons, drafts plans, and can change state only with the user's consent. It must respect Gilde's authentication and use the same business rules as the REST API. It also needs conversation memory per user.

The history shows the implementation but no written comparison of options; the alternatives are retrospective.

## Decision

- The co-pilot is a Mastra agent with id `gilde`, built inside the NestJS API (`apps/api/src/copilot/copilot.mastra.ts`) in a Nest provider, so its tools receive Gilde services by injection. `@mastra/nestjs` is mounted under `/api/v1/mastra`; the CopilotKit/AG-UI route (`registerCopilotKit` from `@ag-ui/mastra`) is `/api/v1/mastra/copilotkit`. Routes sit behind the global JWT/API-key guard (ADR 0003); `CopilotContextInterceptor` puts the user in the request context, and the memory resource id is that user's id.
- The model is an OpenAI model through Mastra's model router. `COPILOT_MODEL` must be `openai/<model>` and has no default; with `OPENAI_API_KEY` missing the routes answer 503 and the rest of the API still starts (`copilot.config.ts`).
- The web app uses CopilotKit (`@copilotkit/react-core`, `@copilotkit/react-ui`): `components/copilot-provider.tsx` points at `/api/gilde/v1/mastra/copilotkit` (through the proxy of ADR 0003) with agent `gilde`.
- Tools (`copilot.tools.ts`) call existing services and return DTOs; they never query repositories or call the HTTP API. The acting user comes from the request context (`copilotUser`), never from tool input. Reading tools run directly. The two tools that create data, `createPlannedFeature` and `createJob`, set `requireApproval: true`, so the run suspends until the user approves; the web renders approval cards through `useInterrupt` (`components/copilot-plan-approval.tsx`). `planFeature` and `validateJob` only validate and create nothing; no tool starts features or enqueues jobs.
- Memory (`apps/api/src/memory/`, Mastra Memory): conversation history, resource-scoped working memory, and semantic recall when embeddings are configured. In production on Postgres (`DATABASE_URL`) it uses the same database as Gilde through `PostgresStore` and `PgVector`; Mastra creates its own tables, not TypeORM migrations. Without a Postgres URL the local fallback is a LibSQL file, `file:mastra.db` (overridable with `MASTRA_DB_URL`), which is separate from the TypeORM `db.sqlite` of ADR 0001.

## Consequences

- Positive: one deployable; tools reuse validated service logic and the user's identity, so the co-pilot can do nothing a user could not. Approval gates are enforced by the framework instead of by prompt text. The AG-UI interface is shared with the channels process (ADR 0005).
- Negative: agent runs share the API process and its resources; the co-pilot depends on fast-moving Mastra, CopilotKit and AG-UI versions (pinned exactly in `package.json`). It requires an OpenAI key and a deliberate model choice. Local development stores memory in a different file than application data.
- Follow-up: only approval-gated tools can create data; any new state-changing tool must also use `requireApproval` (rule in `AGENTS.md`).

## Alternatives considered

Retrospective comparisons.

- **Separate agent service** — isolates load, but needs its own auth and service access, duplicating logic the API already has.
- **Tools that call the REST API** — rejected by the rule in `AGENTS.md`; services are called directly.
- **Another provider or default model** — not supported for now; the `openai/` prefix check is the only provider gate.
