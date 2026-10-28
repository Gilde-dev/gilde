# 0010. Serve an MCP server for operators that can read, triage and draft, nothing more

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** agent job 6de3092f-8914-4bad-be24-a3264ff3f7da, reviewed in its PR
- **Related:** [0003](0003-jwt-cookie-proxy-and-api-keys.md), [0004](0004-copilot-mastra-agent-in-api.md), [0007](0007-verkenner-scout-may-create-triage-jobs.md), [0008](0008-full-replacement-put-controllers-use-services-and-dtos.md), [0009](0009-features-pin-an-approved-spec-version.md); README "MCP server"

## Context

Operators already work in their own MCP client (Claude Code first). To read the factory or put work into it they must open the web UI
and its co-pilot sidebar. ADR 0004 gates every state-changing co-pilot tool behind an in-UI approval; that interrupt does not exist
in an MCP client. ADR 0003 gives machines hashed API keys and ADR 0007 gives the scout a bounded, unattended write (triage jobs only),
which established the principle that a write is acceptable without an interrupt when the server bounds it and a human still holds
every decisive step.

Humans keep the decisive steps in Gilde: queueing, cancelling, retrying, merging, spec approval and settings. The question is how far
an operator's MCP client may go without those.

## Decision

- **Transport.** We serve Streamable HTTP at `POST /api/v1/mcp` from a dedicated `mcp/` Nest module, using `@modelcontextprotocol/sdk`
  (1.32.2, now a direct dependency; it was already in the lockfile through other packages). Every request gets its own `McpServer` and
  a stateless transport (JSON responses, no session id, closed when the response ends). `GET` and `DELETE` answer 405 (there is no
  server-initiated stream and no session). The controller only calls `McpService`; the raw protocol response is written in that
  service, at the transport boundary, so the architecture rules for controllers stay as they are.
- **Switch.** `MCP_ENABLED` defaults off and only the literal `true` enables it. Off, the controller is not registered at all
  (`McpModule.register()`), so the path is a plain 404, also without credentials; there is no `@Public()` and no authentication bypass
  anywhere. On, the route is behind the global `JwtAuthGuard` like every other route. It needs no LLM and no co-pilot configuration.
- **Identity.** The only acting identity is the authenticated `req.user`, captured per request. Before every tool execution the
  account is loaded fresh from the database (`UserService.requireOperator`): server-set JWT or API-key provenance is required, and the
  account must still exist, must not be a bot (as persisted now) and must not be `SCOUT_USER_EMAIL` (normalized, even if not marked as
  a bot). Personal API keys qualify; bots and the scout do not. With `AUTH_ENABLED=false` there is no verified identity, so every tool
  fails closed. `requireVerifiedHuman` (JWT only, for human-only actions such as approving a spec) is unchanged; both now share the
  persisted-account checks in `requirePersistedHuman`. Tool input never carries an actor, creator, credential, bot flag or status.
- **Tools.** An explicit allowlist of 22: the read tools of the co-pilot (`listProjects`, `listRepos`, `listJobs`, `getJob`,
  `listFeatures`, `getFeature`, `listProposals`, `getDispatchStatus`, `getMetrics`, `listLessons`, `getRepoSkills`, `listSpecs`,
  `getSpec`, `searchHistory`, `listRepoFiles`, `readRepoFile`, `searchRepoCode`), the validate-only tools (`validateJob`,
  `planFeature`) and three writes: `createJob` (one job, status `triage`, creator the caller), `createPlannedFeature` (a `draft`
  feature and its `triage` jobs through `FeaturePlanService`, so the approved-version pin, recording prerequisites and all-or-nothing
  creation of ADR 0009 apply) and `draftSpec` (a draft with `expectedVersion`; never approves, never creates a recording job). Schemas,
  bodies and compact DTO mappings are shared with the co-pilot (`copilot.tool-bodies.ts`, `copilot.code-tools.ts`); the Mastra tools
  keep their descriptions, `requireApproval` flags and the scout allowlist. A new co-pilot tool is not exported automatically.
- **Excluded for good.** Queue, dispatch, cancel, retry, merge, spec approval, settings, user and API-key management,
  notifications and working memory are not available over MCP. Every description states this boundary. Failures (validation, stale
  `expectedVersion` 409, daily limits, auth) come back as MCP tool errors (`isError`) with safe messages; HTTP authentication errors
  stay at the HTTP layer.
- **Daily limits.** Per user, across projects and credentials, per UTC day: 20 jobs and 5 features (`MCP_DAILY_JOB_LIMIT`,
  `MCP_DAILY_FEATURE_LIMIT`; non-negative integers, `0` disables that kind; an invalid value fails startup). A planned feature costs one
  feature plus all its jobs from the same job allowance. The counters live in `mcp_usage_days` and are raised by one conditional
  `UPDATE ... WHERE used + n <= limit` inside the transaction that creates the records, so an over-limit, stale or failed creation
  writes nothing and consumes nothing, and concurrent requests, several processes and restarts cannot exceed the limits. On SQLite,
  which has a single connection, MCP's write transactions are queued in-process; that only orders them and never decides a limit.
- **Origin.** Jobs have no creation-source field, so each created job and feature is recorded in an audit log line with
  `source=mcp`, the caller's id, the credential kind and the created ids (no task text, bodies or credentials) after the commit.
- **Stateless protocol, durable accounting.** The protocol keeps nothing between requests; the only server-side state MCP adds is the
  quota table, which has to survive restarts.
- **Exposure is infra.** This repo makes no infrastructure change. Until infra exposes the path, operators reach it through an SSH
  tunnel to `http://localhost:4100/api/v1/mcp`. Whether and how the path is published is an infra decision outside this repo.

## Consequences

- Positive: operators work from their MCP client; the humans' decisive steps are untouched; the write surface is three tools, bounded
  by the server and by triage/draft status, in the spirit of ADR 0007; tool logic is shared, not copied.
- Negative: unlike the sidebar, MCP writes happen on the operator's own call with no interrupt, so the bound is the daily limit plus
  triage; a compromised personal API key can fill the triage lane up to the limits (but not queue or approve anything). The SQLite
  queue and the extra table are new moving parts. A second consumer of the shared tool bodies means a change to a body affects both
  front-ends.
- Follow-up: publishing the endpoint (TLS, network policy) is for infra. Any further MCP write needs its own ADR.

## Alternatives considered

- **`@mastra/mcp` `MCPServer`.** It is not installed, ties the tools to Mastra's tool and request-context model (the co-pilot's
  `copilotUser`) and would add a dependency; keeping the Nest global guard and a request-scoped identity is simpler with the SDK in a
  controller.
- **A separate MCP process (like the channels process).** Would duplicate authentication and need its own database access or an
  HTTP hop to this API; the tools are thin calls to services that already live here.
- **Stateful sessions.** A session store is shared mutable state and a place for one request's identity to leak into another; nothing
  here needs server-initiated messages.
- **Exempt API keys of bots or the scout.** The scout is bounded by ADR 0007 in its own way and is not an operator; bots are machines
  whose writes are not attributable to a person.
- **A process-local counter for the daily limits.** Lost on restart and wrong with more than one process.
- **Expose the approval-gated co-pilot tools as they are.** Their `execute` callbacks assume the approval already happened; calling
  them from MCP would be an approval bypass.
