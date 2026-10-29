# 0016. One agent run log with redacted, capped tool calls

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** agent job 5d571258-6279-4cd9-b901-5fe049d11d34, reviewed in its PR
- **Related:** [0004](0004-copilot-mastra-agent-in-api.md), [0007](0007-verkenner-scout-may-create-triage-jobs.md), [0010](0010-mcp-server-for-operators-triage-and-draft-only.md), [0011](0011-personal-executors-with-encrypted-routine-tokens.md), [0013](0013-verfijner-bounded-unattended-spec-drafter.md), [0015](0015-werkmeester-bounded-unattended-planner.md); spec `agents-page-and-runtime-settings` (docs/specs/agents-page-and-runtime-settings.md), AC-5, AC-6; README "Agent run log"

## Context

What an agent did is kept in separate places: scout activity, `intake_refine_runs`, `spec_planning_runs`, `job_runs`, `llm_usage` and Mastra memory threads.
None of them records the tool calls of an agent, and there is no single view of "what did this agent do and why". The tools of the agents read project
data and, for the co-pilot, a user's private conversation, so a log of their inputs and outputs can leak secrets (tokens in tool arguments or in
files that were read) and other users' conversations.

Mastra's `onFinish` callback has the usage but neither the request context nor an id we can match to the start of the run. Its tools have no hook that sees
both the tool call and the request. The agents run in four different ways (a user's HTTP request, a notification wake, two scheduled workers) plus MCP
calls and coding-agent job runs, which end days later by a GitHub webhook.

## Decision

We keep one log, `agent_runs`, and one table of tool calls, `agent_tool_calls`, next to the existing per-agent tables, which keep working; a run links to
its row (`linked_table`, `linked_id`).

- **One recorder.** `AgentRunRecorder` (a global Nest provider) is the only writer. `begin` returns a handle synchronously; the writes are queued behind each
  other in the background and every error is logged and swallowed, so recording never fails or slows the run it records. Callers also wrap the start, so even
  a recorder that throws cannot change a run.
- **Where a run starts and ends.** The Verfijner and Werkmeester workers start and end their runs (they know the outcome) and put the handle in the request
  context of the stream. The co-pilot and the scout start theirs at the first step (`prepareStep`) from the request context, which already holds the user, the
  selected project or the server-issued binding. Their end is a Mastra output processor (`processOutputResult`), the supported hook that has both the request
  context and the token usage. Each MCP tool call is one run. A coding-agent run starts with its `job_runs` row and is ended by the code that already moves
  that row (fire failure, PR opened, PR closed). A run that never reports an end is closed as `error` by an hourly sweep.
- **Tool calls by wrapping.** The tool set an agent resolves for a request is wrapped (`recordTools`): the original tool objects are copied, never changed, and
  results and errors pass through untouched.
- **Redaction before capping.** Input, output, errors and reasons pass through one redaction step (known token formats and the values of configured secrets),
  then are capped at `AGENT_LOG_MAX_CHARS` (default 2000). Redacting first means a secret cut by the cap leaves no readable prefix.
- **Privacy in the read API.** `GET /api/v1/agents/:id/runs` and `GET /api/v1/agent-runs/:id` return, for another user's co-pilot run, metadata only (time, tool
  count, outcome, model, tokens, cost); the content (reason, thread, tool names, inputs, outputs) is left out in the service, not in the UI.
- **Retention.** `AGENT_LOG_RETENTION_DAYS` (default 90) is applied by a daily job that deletes runs and their tool calls.

## Consequences

- One query answers what any agent did, with tool calls, and the Agents page can be built on it. The per-agent tables stay the source of truth for their own
  state; the log is evidence, so losing a row (a swallowed error) never changes behaviour.
- Redaction is a best-effort safety net on shapes and configured values; a secret of an unknown shape in a tool output is stored (capped). The log therefore
  holds data other users wrote and must be shown as plain text.
- Recording is asynchronous: a crash can lose the last rows of a run, and the sweep closes runs that never ended.
- `onFinish` of the existing usage recording still has no request context, so `llm_usage.user_id` for chat is not attributed through it; the run log is.
  Fixing that is separate work.
- Tool inputs are stored once more (capped), which costs storage; retention bounds it.
- Wrapping copies Mastra tool objects. A Mastra upgrade that adds private state to tools would need the wrapper revisited; a test runs a real agent with the wrapped
  tools to catch it.

## Alternatives considered

- **Mastra's built-in observability/tracing.** It would record steps and tools without our wrapper, but it has no notion of Gilde's triggers, actors or privacy
  rule, cannot cover MCP calls and coding-agent runs, and would put prompts and outputs in a store we do not control the redaction of.
- **Derive the log from the per-agent tables at read time.** No tool calls exist there and the tables differ per agent; a union view would not give one
  filterable, paginated, privacy-aware list.
- **Record through `onFinish` only.** It lacks the request context, so a run could not be attributed to the user or the project.
- **Block on the write.** Simpler to reason about, but a database problem in the log would then fail a chat or a scheduled run.
