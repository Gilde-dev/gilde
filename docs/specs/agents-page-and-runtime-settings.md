## Goal

Give operators one place to see and manage every agent and bot in Gilde: which ones exist, whether they are on and why not, which bot account and model they use, their limits, their exact tools and prompt, and what they have been doing. Move the runtime settings of the agents from environment variables into the database so they can be changed without a deploy, while secrets, infrastructure and kill switches stay in the environment.

## Context

- Agents and bots today: the co-pilot (`gilde`), the Verkenner (`verkenner`), the Verfijner (`verfijner`), the Werkmeester (`werkmeester`), the MCP server for operators, the Slack bot (the channels app, an API key of a bot user) and the coding agents in each user's Claude Code routine (executors, with `docs/agent-instructions.md` plus the job payload as their prompt).
- Their runtime settings are environment variables read at startup: `COPILOT_MODEL`, `COPILOT_MAX_STEPS`; `SCOUT_ENABLED`, `SCOUT_USER_EMAIL`, `SCOUT_MODEL`, `SCOUT_MAX_WAKES_PER_DAY`, `SCOUT_DAILY_SUGGESTIONS`, `SCOUT_SUMMARY_HOUR_UTC`, `SCOUT_PATTERN_MIN_SIZE`; `REFINE_ENABLED`, `REFINE_USER_EMAIL`, `REFINE_MODEL`, `REFINE_DAILY_LIMIT`; `PLAN_ENABLED`, `PLAN_USER_EMAIL`, `PLAN_MODEL`, `PLAN_DAILY_LIMIT`; `MCP_DAILY_JOB_LIMIT`, `MCP_DAILY_FEATURE_LIMIT`, `MCP_TOOL_TIMEOUT_MS`, `MCP_TOOL_RESULT_MAX_CHARS`; `DISPATCH_LESSONS_TOP_K`, `DISPATCH_LESSONS_MIN_SCORE`, `DISPATCH_LESSONS_TIMEOUT_MS`. A bot account that was not marked as a bot recently made dispatch wait for a non-existent executor; choosing bot users from a list prevents that.
- Agent activity is recorded in separate places today (scout activity, `intake_refine_runs`, `spec_planning_runs`, `llm_usage`, Mastra memory threads), so there is no single view of what an agent did.
- Instructions live in code (`copilot/*.instructions.ts`, `docs/agent-instructions.md`) and carry tested safety rules (untrusted data, bindings, allowlists).
- Assumption: prompts stay in code and are shown read-only; editing a prompt remains a code change through a job, so review and tests stay in the path.
- Assumption: environment variables become a ceiling and the seed: on first start their values become the database settings; afterwards the database is used, but an agent that its environment kill switch disables stays off whatever the database says.
- Assumption: other users' co-pilot conversations are private; the agents page shows only their metadata.

## Behaviour

Settings in the database. Each agent has a settings record: enabled, bot user (chosen from users marked as bots; not applicable to the co-pilot and the coding agents), model (`openai/<model>` format), and its limits and schedule (the variables listed in Context, with the same validation and defaults as today). On first start without a record, Gilde seeds it from the current environment variables. A verified human can change settings through the API and the agents page; every change is audited (who, when, field, old and new value). Changes take effect without a restart: workers read the settings on each tick, and agents resolve their model per run. Invalid values are rejected with field errors; an agent whose settings are invalid or whose bot user is not a bot is shown as misconfigured with the reason and does not run.

Environment stays for secrets, infrastructure and kill switches. Secrets (LLM keys, `EXECUTOR_SECRET_KEY`, JWT, GitHub App, Slack and OTel tokens), infrastructure (`DATABASE_URL`, `MEMORY_EMBEDDING_*`, `AGENT_INSTRUCTIONS_PATH`) and `MCP_ENABLED` remain environment-only. A new `AGENTS_DISABLED` (comma-separated agent ids, or `all`) forces agents off regardless of the database, and the page shows "disabled by the environment".

Uniform run log. Every run of the Verkenner, Verfijner and Werkmeester, every co-pilot request, every MCP tool call and every coding-agent job run is recorded in one `agent_runs` log: agent, trigger (chat, signal, schedule, intake item, spec version, dispatch, MCP call) with a link to the triggering object, acting user or bot, project, start and end, outcome (ok, error, refused, skipped) with a short reason, model, tokens and estimated cost where known. Tool calls of Gilde's own agents are recorded in `agent_tool_calls`: tool name, input and output truncated to a cap (default 2000 characters each), duration and error, never secrets. The existing per-agent tables keep working; the log links to them. Retention is configurable (default 90 days).

Agents page. `/agents` lists every agent and bot with status (on, off, misconfigured with reason, disabled by environment), bot user, model, today's usage against its limits, trigger, and last run. The detail page has four tabs: Configuration (editable by verified humans, with the audit trail), Tools (the exact allowlist with read/write and, per project, the attached MCP tools), Prompt (the instructions exactly as the agent receives them, with dynamic parts filled in for an example binding, the version hash and a link to the file at the deployed commit) and Activity (runs, filterable by trigger, outcome and project, each expandable to its tool calls). For the coding agents the Prompt tab shows `docs/agent-instructions.md` and how the job payload is assembled (sections and limits), and Activity shows job runs per executor. For the Slack bot it shows its account and the notification kinds it delivers.

Privacy and safety. Co-pilot runs of other users show only metadata (time, tool count, outcome, cost), never message content; a user sees the content of their own runs. Recorded tool inputs and outputs are capped and shown as plain text. Only verified humans change settings; API keys, bots and the scout are refused.

## Acceptance criteria

- AC-1: Each agent's runtime settings (enabled, bot user, model, limits, schedule) live in the database, seeded once from the current environment variables, with the same validation and defaults as today.
- AC-2: A verified human can change settings through the API and the agents page; changes are audited with old and new values and take effect without a restart; API keys, bots and the scout are refused.
- AC-3: Bot users are chosen from users marked as bots, and an agent with invalid settings or a non-bot user is shown as misconfigured with the reason and does not run.
- AC-4: Secrets, infrastructure variables and `MCP_ENABLED` stay environment-only, and `AGENTS_DISABLED` forces the named agents (or all) off regardless of the database, shown as disabled by the environment.
- AC-5: Runs of the Verkenner, Verfijner, Werkmeester, co-pilot requests, MCP tool calls and coding-agent job runs are recorded in one run log with agent, trigger and link, actor, project, timing, outcome, model and tokens/cost where known, with configurable retention.
- AC-6: Tool calls of Gilde's own agents are recorded with capped input and output, duration and error, and never contain secrets.
- AC-7: `/agents` lists every agent and bot with status and reason, bot user, model, usage against limits, trigger and last run.
- AC-8: The agent detail page shows Configuration with the audit trail, Tools with read/write and project MCP tools, Prompt exactly as received with version and file link, and Activity with filterable runs and their tool calls; coding agents and the Slack bot have their own variants.
- AC-9: Other users' co-pilot runs show only metadata, recorded content is shown as escaped plain text, and prompts are read-only.
- AC-10: README and an ADR describe settings in the database with the environment as seed and ceiling, the run log and its retention, and why prompts stay in code.

## Out of scope

- Editing prompts or instructions in the database or the UI.
- Moving secrets or infrastructure settings out of the environment.
- Per-project agent settings beyond the existing project-level ones such as `autoPlan`.
- Replaying or re-running an agent run from the page.

## Open questions

None.
