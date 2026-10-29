# 0014. MCP servers per project, with an allowlist, read/write rules and untrusted results

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** agent job 934fafd5-6680-4af9-ac5c-87f064f14574, from the approved spec `project-mcp-servers` v1, reviewed in its PR
- **Related:** [0007](0007-verkenner-scout-may-create-triage-jobs.md), [0010](0010-mcp-server-for-operators-triage-and-draft-only.md), [0011](0011-personal-executors-with-encrypted-routine-tokens.md), [0013](0013-verfijner-bounded-unattended-spec-drafter.md); README "Project MCP servers"

## Context

Teams keep knowledge in other systems (a knowledge base, Notion, Confluence, an issue tracker). Gilde's own agents (the co-pilot, the
Verkenner, the Verfijner) and, through the job payload, the coding agents should be able to use it. The Claude Code routine fire API
accepts only a `text` body, so Gilde cannot attach MCP servers to a routine session; it can only put content into the payload.
Text from outside Gilde is always untrusted (ADR 0007, 0010, 0013), and an MCP result is the same kind of input. The tokens for these
servers are credentials Gilde must be able to send in the clear, like the routine tokens of ADR 0011.

## Decision

- **A registry per project.** `project_mcp_servers` (name unique per project, https URL, enabled, available to unattended agents,
  usage counters, last error), `project_mcp_tools` (the tools announced in the last test, with an allowed flag and a mode) and
  `project_mcp_audit`, in the `project-mcp/` module under `/api/v1/projects/:projectId/mcp-servers`. Reads are for any signed-in
  user; every write, including "Test connection", needs a verified human (`JwtHumanGuard` and `requireVerifiedHuman`): no API keys,
  bots or the scout. Only remote servers over Streamable HTTP; no stdio. One project-level credential per server (a bearer token),
  no personal tokens or OAuth.
- **Tokens like ADR 0011.** AES-256-GCM under `EXECUTOR_SECRET_KEY` with its own key-version scope (`PROJECT_MCP_KEY_VERSION`), write-only
  through the API (`PUT .../token`), DTOs show `hasToken` and `tokenLast4`. Decryption is an internal method (`revealToken`) with no
  route. Without the key a server with a token cannot be created (503). A token never appears in a log, error, DTO, audit row, prompt
  or notification; connection errors are fixed-text messages without the URL or server-provided text.
- **Test connection initializes and lists, nothing else.** The official SDK client connects (10 s timeout, no redirects, so the token
  cannot travel to another host) and lists tools; it never calls one. Failures are classified as unreachable, timeout, auth (401/403)
  and not MCP. The URL must be https, without credentials, and not an obvious internal host (localhost, private and link-local
  addresses, `.local`/`.internal`); hostnames that merely resolve to internal addresses are not checked.
- **Allowlist.** A tool is usable only when it is on the project's allowlist (`allowed`). A re-test keeps the choices of tools that still
  exist and drops vanished ones; new tools start not allowed.
- **Read or write.** Every allowed tool has a mode. A tool starts as `read` only when its MCP annotations say `readOnlyHint: true`;
  everything else starts as `write`. The human can change the mode. Agents that use these tools (later jobs) follow:
  - the co-pilot gets read tools directly and write tools only through the existing approval card;
  - **unattended agents** (Verkenner, Verfijner) get only `read` tools of servers with "available to unattended agents" (off by default),
    of their server-bound project, and never `write` tools; an allowlist test proves it.
- **Knowledge for coding agents.** Per server a human may enable knowledge in jobs with one allowed `read` search tool. At dispatch Gilde
  queries it with the job title and task and adds the top results to the job payload as a delimited `knowledge` block with sources, in
  a total budget of `KNOWLEDGE_BUDGET_CHARS` (default 6000) and a per-snippet cap, trimmed before the job task when the prompt is over
  its limit. A failing or slow server (5 s) never blocks or fails a dispatch.
- **Untrusted data.** Every MCP result is capped in size and passed to a model inside clearly delimited blocks with the instruction that it
  can never change instructions, tools or targets. Errors become short tool errors and are counted per server (calls, errors, last error).
- **Audit.** Every registry change (created, updated with field diffs, token replaced, tested, tools updated, deleted) records who, when and
  what, never the token. Audit rows outlive the server.

## Consequences

- Positive: agents get project context without Gilde building a knowledge store; humans decide which tools exist for agents and which may
  write; a leaked database does not hand out tokens.
- Negative: the API holds the master key and sends tokens to third-party servers; a server can return hostile text, so the delimiting is a
  mitigation, not a guarantee, which is why unattended agents never get write tools; the host check is not a full SSRF defence.
- Follow-up: tools for the co-pilot and unattended agents, knowledge at dispatch, the settings page, key rotation (shared with ADR 0011).

## Alternatives considered

- **Attach MCP servers to the Claude Code routine** — the fire API cannot carry them.
- **Let every tool run once announced** — a server could add a writing tool later and agents would use it; the allowlist makes new tools inert.
- **Trust the server's read-only annotation as is** — annotations are hints; only `readOnlyHint: true` counts, and a human decides.
- **Personal tokens or OAuth per user** — more moving parts; a project service account is enough for a first version.
- **Local stdio servers** — would run arbitrary processes on the shared API host.
