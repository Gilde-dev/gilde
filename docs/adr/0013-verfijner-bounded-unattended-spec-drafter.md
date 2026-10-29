# 0013. The Verfijner drafts specs from intake items as a bounded unattended writer

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** agent job 2db241c7-4338-4fad-bf24-13426eea5b82, reviewed in its PR
- **Related:** [0004](0004-copilot-mastra-agent-in-api.md), [0007](0007-verkenner-scout-may-create-triage-jobs.md), [0009](0009-features-pin-an-approved-spec-version.md), [0010](0010-mcp-server-for-operators-triage-and-draft-only.md); README "Issue intake" and "Verfijner"

## Context

Work is usually written down as GitHub issues before it reaches Gilde. The intake domain turns issues that carry the label
`gilde:refine` into intake items. Turning an item into a draft spec by hand is the step left, and it is mechanical enough for an
agent: read the issue and the repo, write a spec in the six-section template.

Unlike the co-pilot (ADR 0004), nobody is in front of this agent to approve its writes; it runs from a worker. Its input is an issue
body, text any outsider with triage rights on the repo, or whoever the label-setter chose to trust, can write. That is the same
shape as ADR 0007 (the scout reads untrusted job text and may write triage jobs) and ADR 0010 (MCP writes on an operator's own call):
a write without an interrupt is acceptable when the server bounds it and a human still holds every decisive step. Here the decisive
steps are approving a spec and planning from it (ADR 0009), and they stay human.

## Decision

We add a third Mastra agent, `verfijner`, in the same Mastra instance and storage as `gilde` and `verkenner`, and allow it exactly one
unattended write: a draft spec for its own intake item.

- **Opt-in and fail closed.** It is on only with `REFINE_ENABLED=true`, a valid model (`REFINE_MODEL`, fallback `COPILOT_MODEL`),
  `OPENAI_API_KEY` and `REFINE_USER_EMAIL` naming an existing bot user (`users.is_bot`; a human account is refused). An invalid
  `REFINE_DAILY_LIMIT` turns it off. Off or misconfigured, the API starts, the reason is logged without secrets, and items stay `new`.
- **Bot identity.** It acts as that bot user; specs it saves have the bot as creator and updater. The bot can never pass
  `requireVerifiedHuman`, so it cannot approve.
- **Server-issued binding to one item.** A worker (every minute) picks the oldest `new` item whose body sha differs from
  `refined_sha256`, one item at a time per project, sets it `refining` and starts a run whose request context holds a binding issued
  by the server for exactly that item: project, repo, item id and linked spec id. A binding is trusted only if the server module
  created that object (a private `WeakSet`); a look-alike from an HTTP body or tool input is not. No tool takes a project, repo, item
  or spec as input.
- **Tools, by allowlist.** Read-only: `listSpecs`, `getSpec` (of the bound project), `searchHistory` (bound project), and the code tools
  `listRepoFiles`, `readRepoFile`, `searchRepoCode` on the bound repo. One write: `saveRefinedSpec({ title, body })`. It creates the
  item's spec (slug `issue-<number>-<title>`, a numeric suffix when taken) or, when the item is already linked to one, saves a new
  draft version with that spec's current `expectedVersion`, through `SpecService` as the bot user, and links the item. The body must pass the
  spec parser and contain the issue URL; otherwise the tool returns the errors so the agent can fix and retry within the same run.
  It never approves, plans, queues, comments or writes anywhere else. An allowlist test pins the tool names.
- **An approved spec stays approved.** Saving a version only adds a draft version; the earlier approval and its recording stay as
  evidence (ADR 0009 pins are unaffected). Edits to an issue add versions, never overwrite.
- **Issue text is data.** The title and body are in the user message between boundary lines with a random per-run nonce, so the text
  cannot close its own block, and the instructions say they never change instructions, tools or targets. Because targets come from the
  binding and not from the model, a successful injection still cannot reach another item, repo or project.
- **Cost control.** A daily limit per project (`REFINE_DAILY_LIMIT`, default 10 runs per UTC day, counted in `intake_refine_runs`),
  no run while the project's or the global budget is hard (an unreadable budget counts as hard), a step limit, and 2 attempts per
  item and body version before the item is `failed` with a short error. A human can retry a failed item.
- **One status comment per issue, answers as data (added with issue-side intake).** The flow now writes to GitHub in one place:
  a single status comment per intake item, created and edited as the GitHub App (needs **Issues: write**; *Issue comment* webhook
  events are subscribed), through one narrow `GitHubPort` method used via `GitHubCredentials`. It is found by a hidden marker, edited
  in place, not rewritten when unchanged and written at most once per item per minute. It shows the spec link, version, status, the
  open questions verbatim and how to answer, never the spec body. Comments of OWNER, MEMBER and COLLABORATOR on an issue with an
  intake item (the label's trust level) are read as data: stored capped (4000 characters, 20 most recent), included in the item's
  refine sha and given to the Verfijner between nonce-marked boundary lines like the issue text; other commenters, bots and the app's
  own comment are dropped unstored, so the status comment cannot trigger a refine. A refused write only records a short
  `comment_error` on the item and never fails the refine, approval or plan. The agent itself still has no write beyond
  `saveRefinedSpec`; the comment is written by the server.
- **Not reachable over HTTP.** The interceptor refuses any Mastra request that names `verfijner` (403), like `verkenner`; the agent is
  not listed on the CopilotKit route, and its memory threads (`verfijner:<item>:<attempt>`, resource = the bot user) are never shown
  as conversations.

## Consequences

- Positive: issues become reviewable draft specs without anyone drafting by hand, while approval, planning and queueing remain human;
  the blast radius of a hostile issue is one draft spec of its own item; the cost is capped per project and by the budget guard.
- Negative: a hostile or sloppy issue can fill the spec list with a poor draft (bounded by the daily limit and by the human labelling
  step); the agent reads repo code, so repo content is sent to the model provider like it already is for the co-pilot. A new table
  and a minute-cadence worker are more moving parts. Run counts are per attempt, so retries cost allowance.
- Follow-up: the `/intake` page (retry, ignore) and the issue link on specs. Writing anything else back to GitHub or other trackers
  needs its own ADR; the status comment is the only write and needs the app's Issues: write permission.

## Alternatives considered

- **Let the human co-pilot refine on request.** Needs a person per issue and an open session; the point is to work unattended.
- **Reuse the scout's thread and tools.** The scout is bound to a project and read-only except triage jobs; a spec writer bound to
  an item needs a different binding and a different single write. Separate agents keep both allowlists small and testable.
- **Let the agent pass the item or spec id to the tool.** Makes the issue text able to steer the write; the binding removes that.
- **Let the agent post the comment as a tool.** Would put a GitHub write, with issue-influenced text, in the model's hands; the server renders
  the comment from the spec instead, so its content is bounded and the agent's allowlist stays one write.
- **Overwrite the spec on edits.** Loses what a human may already have reviewed or approved; versions are immutable (ADR 0009).
- **Count the daily limit in memory.** Lost on restart and wrong with more than one process.
