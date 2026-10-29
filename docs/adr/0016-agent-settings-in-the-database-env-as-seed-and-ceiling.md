# 0016. Agent runtime settings live in the database; the environment is the seed and the ceiling

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** agent job 375bcd4a-b169-4114-bca3-5543d40c8b48, reviewed in its PR
- **Related:** [0004](0004-copilot-mastra-agent-in-api.md), [0007](0007-verkenner-scout-may-create-triage-jobs.md), [0010](0010-mcp-server-for-operators-triage-and-draft-only.md), [0013](0013-verfijner-bounded-unattended-spec-drafter.md), [0015](0015-werkmeester-bounded-unattended-planner.md); spec `agents-page-and-runtime-settings` (docs/specs/agents-page-and-runtime-settings.md); README "Agent settings"

## Context

The runtime settings of the agents (on or off, bot user, model, daily limits, the Verkenner's schedule, the MCP and lesson limits) were environment
variables read once at startup. Changing a limit or switching an agent on meant a deploy and a restart. Creating the bot user *after* starting the API
also needed a restart, because the Verfijner and the Werkmeester resolved their user only at startup, and a bot account that was not marked as a bot made
dispatch wait for an executor that cannot exist. An operator could not see in one place which agents are on, and why one is not.

Some of that configuration must stay out of reach of a web form: secrets, infrastructure, and the switches an operator uses when something goes wrong.

## Decision

We keep the runtime settings of each agent in the database, in `agent_settings` (one row per agent id: `gilde`, `verkenner`, `verfijner`, `werkmeester`,
`mcp`, `coding`), and audit every change in `agent_settings_audit` (agent, field, old and new value, who, when).

- **The environment is the seed.** At startup an agent without a record gets one from the current variables (`*_USER_EMAIL` resolved to the user id). An
  existing record is never overwritten from the environment, so a changed variable has no effect afterwards. An invalid numeric value seeds the default and,
  for the agents that failed closed before (Verkenner, Verfijner, Werkmeester, MCP), seeds the agent switched off.
- **The environment is the ceiling.** `AGENTS_DISABLED` (comma-separated agent ids, or `all`; an unknown id fails the startup) forces those agents off
  whatever the database says, and the status is `disabled_by_env`. `MCP_ENABLED=false` keeps the MCP server off whatever its record says.
- **What stays environment-only:** secrets (LLM keys, `EXECUTOR_SECRET_KEY`, JWT, GitHub App, Slack and OTel tokens), infrastructure (`DATABASE_URL`,
  `MEMORY_EMBEDDING_*`, `AGENT_INSTRUCTIONS_PATH`) and `MCP_ENABLED`. A secret in a table that a web form writes is a bigger exposure than a restart is an
  inconvenience, and the kill switches must work when the database or the page is the problem.
- **One place decides what an agent is now:** `AgentRuntimeService`. The status is `on`, `off`, `misconfigured` (with the reason: invalid settings, no bot
  user, a deleted user, a user that is not a bot, no model, no key) or `disabled_by_env`. The stored settings are rendered as the variables the existing
  parsers (`*.config.ts`) read, and those parsers give the final verdict, so validation and defaults are the same as before; a test compares them.
- **No restart:** the Verfijner and Werkmeester workers, the dispatcher, the quota of the MCP server and the Verkenner's signal path read the status on each
  tick or call; the Mastra agents resolve their model and step limit per run and throw (refusing the run) while the agent is not on. The agents are built
  once at startup, except for an agent that `AGENTS_DISABLED` names, which is left out until the next restart.
- **Writes** go through `PUT /api/v1/agents/:id/settings`, a full replacement by a verified human (`requireVerifiedHuman`: an interactive JWT; API keys, bots
  and the scout are refused), with field errors. Bot users are chosen from users marked as bots. Reads are open to any authenticated user and carry no secrets.
- **Prompts stay in code** (`*.instructions.ts`, `docs/agent-instructions.md`) and are shown read-only. They carry tested safety rules (untrusted data,
  bindings, allowlists); editing one stays a code change through a job, so review and tests stay in the path.

## Consequences

- An operator can switch an agent on or off, change its model or limits, and fix a bot user without a deploy; every change has an author and a time.
- A misconfigured agent is visible with its reason, and creating the bot user later works without a restart.
- Two sources of truth exist for a while: after the seed, editing an environment variable does nothing, and the README says so. `AGENTS_DISABLED` is the one
  variable that keeps overriding.
- The settings are read often (each tick and call): a few small queries, and a per-minute refresh for the synchronous readers. A settings change is seen by
  those readers within a minute at worst (immediately in the process that handled the write).
- Enabling an agent that was named by `AGENTS_DISABLED` at startup needs a restart without that name, because its agent and wiring were left out.
- The run log, the `/agents` page and the tools and prompt views build on this and follow in later jobs.

## Alternatives considered

- **Keep the environment and add a read-only page.** No restart-free change, which was the problem.
- **Store everything in the database, secrets included.** Rejected: a web form would write secrets, and the kill switch would depend on the database.
- **Overwrite the database from the environment at every start.** Rejected: a deploy would silently undo an operator's change.
- **Build and rebuild the agents when a setting changes.** More moving parts and a window in which a run uses a half-built agent; resolving the model per
  run and checking the status per tick is simpler.
- **A separate validator for the database values.** Rejected: two validators drift; the existing parsers judge, the field table only produces field errors.
