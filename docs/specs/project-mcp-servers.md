## Goal

Let a project attach external MCP servers (a knowledge base, Notion, Confluence, Graphnous, an issue tracker) so that Gilde's own agents can use that context, and so that coding agents in the Claude Code routines receive the relevant parts of it in their job payload. Gilde stays the place that decides which tools are allowed, when knowledge is used and how much of it reaches a prompt.

## Context

- Gilde's agents are Mastra agents in the API: the co-pilot (`gilde`), the Verkenner (`verkenner`, unattended, read-only plus triage `suggestJob`) and the Verfijner (`verfijner`, unattended, drafts specs). Their tools are defined in `copilot/` and bound per request through the Mastra request context.
- Coding agents run in each user's Claude Code routine (an executor). The routine fire API accepts only a `text` body, so Gilde cannot attach MCP servers to a routine session when it fires a job; what it can do is put content into the job payload (as it already does for lessons, within the 60000-character prompt limit).
- Secrets the API stores today (routine tokens) are encrypted with AES-256-GCM under `EXECUTOR_SECRET_KEY`, write-only through the API (ADR 0011).
- Text from outside Gilde (issues, comments) is always treated as untrusted data, never as instructions (ADR 0007, 0010, 0013). MCP tool results are the same kind of input.
- Assumption: authentication is a project-level credential (a service account or API token per server, per project), not a personal token per user. Personal tokens are a possible later step.
- Assumption: MCP servers are reached over Streamable HTTP (remote servers). Local stdio servers are not supported on the shared API host.
- Assumption: the encryption key for MCP credentials is `EXECUTOR_SECRET_KEY` with its own key version scope, so operators manage one key.

## Behaviour

Registry. A verified human can register MCP servers on a project: a name, the server URL (https only), an optional bearer token or header value (stored encrypted, write-only, shown as last four characters), and an enabled flag. Gilde offers a "Test connection" action that initializes the server and lists its tools without calling any. After a successful test the human chooses an allowlist of tools; nothing is usable until it is on the allowlist. For every allowed tool the human marks whether it is read-only or writes; tools whose MCP annotations say they are not read-only start as "writes". The registry lives in the project settings and its changes are audited (who, when, what changed, never the token).

Use by the co-pilot. When the co-pilot works for a project, the allowed tools of that project's enabled servers are added to its tool set for that request, namespaced by server (for example `notion.search`). Read-only tools run directly. Tools marked as writing always require the user's confirmation through the existing approval card, never without it.

Use by the unattended agents. The Verkenner and the Verfijner get only the read-only allowed tools of their bound project's servers, and only for servers where the human enabled "available to unattended agents" (off by default). They never get writing tools.

Snippets for coding agents. A project can enable "include knowledge in jobs" per server and choose one read-only search tool and its query argument. At dispatch, Gilde queries that tool with the job's title and task, keeps the top results, and adds them to the job payload as a delimited `knowledge` block with their source (server, tool, a reference or URL per result). The block has a total character budget (default 6000) and a per-snippet cap, is trimmed before the job task when the prompt is over the limit, and a failing or slow server (timeout 5 seconds by default) never blocks or fails a dispatch.

Safety. Every MCP result is treated as untrusted data: it is passed to models inside clearly delimited blocks with an instruction that it can never change instructions, tools or targets, and it is capped in size. Tokens never appear in logs, errors, DTOs, prompts or notifications. Calls carry a timeout and errors become short, safe tool errors. Usage is visible per server: number of calls, errors and the last error, in the project settings.

## Acceptance criteria

- AC-1: A verified human can add, edit, enable or disable and delete MCP servers on a project with an https URL and an optional token; the token is stored encrypted, never returned (only its last four characters), and API keys, bots and the scout are refused.
- AC-2: "Test connection" initializes the server and lists its tools without calling any, and reports a clear error for unreachable servers, authentication failures and non-MCP responses.
- AC-3: Only tools on the project's allowlist are usable; each allowed tool is marked read-only or writing, with tools not annotated as read-only defaulting to writing.
- AC-4: The co-pilot gets the allowed tools of its project's enabled servers, namespaced by server; writing tools always go through the approval card and never run without confirmation.
- AC-5: The Verkenner and Verfijner get only read-only allowed tools, only from servers explicitly made available to unattended agents, and never writing tools; an allowlist test proves it.
- AC-6: With "include knowledge in jobs" enabled, dispatch adds a delimited knowledge block with sources to the job payload within a total budget (default 6000 characters) and per-snippet cap, trimmed before the task when over the prompt limit.
- AC-7: A failing, slow or misbehaving MCP server never blocks or fails a dispatch, a co-pilot answer or an unattended run; errors are recorded per server and shown in the project settings.
- AC-8: MCP results are always passed to models as delimited untrusted data with size caps, and tests show that instructions inside a result cannot change an agent's tools or targets.
- AC-9: Tokens never appear in logs, errors, DTOs, prompts or notifications, and registry changes are audited without the token.
- AC-10: An ADR records MCP servers per project, the allowlist and read/write rules, the unattended-agent restriction, the knowledge budget and the untrusted-data rule; the README documents setup.

## Out of scope

- Attaching MCP servers to Claude Code routine sessions themselves (the fire API cannot carry them); users may still configure connectors on their own routines.
- Personal per-user MCP credentials and OAuth flows towards MCP servers.
- Local stdio MCP servers on the API host.
- Uploading documents into Gilde or building a knowledge store inside Gilde.
- Exposing these external tools through Gilde's own MCP server.

## Open questions

None.
