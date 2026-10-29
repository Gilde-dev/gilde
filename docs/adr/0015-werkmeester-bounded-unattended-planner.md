# 0015. The Werkmeester plans features from approved spec versions as a bounded unattended writer

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** agent job bd933189-e1ee-45c9-bcde-250b51a22723, reviewed in its PR
- **Related:** [0004](0004-copilot-mastra-agent-in-api.md), [0007](0007-verkenner-scout-may-create-triage-jobs.md), [0009](0009-features-pin-an-approved-spec-version.md), [0010](0010-mcp-server-for-operators-triage-and-draft-only.md), [0013](0013-verfijner-bounded-unattended-spec-drafter.md); spec `werkmeester-planner` (docs/specs/werkmeester-planner.md); README "Werkmeester"

## Context

A human approves a spec version (ADR 0009), which records it and unlocks planning: a feature pinned to that version with jobs in triage that wait for
the recording job. Writing those jobs by hand, with explicit dependencies and every acceptance criterion covered, is mechanical enough for an agent. The
co-pilot can do it, but only with a person in front of it to press the approval card (ADR 0004).

The unattended writers so far are bounded the same way: the Verkenner may add triage jobs (ADR 0007), MCP operators may triage and draft on their own
authenticated call (ADR 0010), and the Verfijner may save a draft spec for its own intake item (ADR 0013). The Verfijner reads untrusted issue text, so it
must not also create jobs; the approval between drafting and planning is the trust boundary, and the Werkmeester starts only after it.

## Decision

We add a fourth Mastra agent, `werkmeester`, in the same Mastra instance and storage as `gilde`, `verkenner` and `verfijner`, and allow it exactly one
unattended write: a draft feature with triage jobs, pinned to the one approved spec version of its run.

- **Opt-in and fail closed.** It is on only with `PLAN_ENABLED=true`, a valid model (`PLAN_MODEL`, fallback `COPILOT_MODEL`), `OPENAI_API_KEY` and
  `PLAN_USER_EMAIL` naming an existing bot user (`users.is_bot`; a human account is refused). Off or misconfigured, the API starts, the reason is
  logged without secrets, and `WerkmeesterService.enabled` is false.
- **Its own bot identity.** Separate from the Verkenner's and the Verfijner's, so plans and jobs are attributable. The bot can never pass
  `requireVerifiedHuman`, so it cannot approve or queue.
- **Server-issued binding to one spec version.** A run's request context holds a binding issued by the server (project id, spec id, version, approval
  id), trusted only if this module created the object (a private `WeakSet`); a look-alike from an HTTP body or tool input is not. No tool takes a
  project, spec, version or approval as input, and `proposePlan` ignores any such field the model sends.
- **Tools, by allowlist.** Read-only: `listSpecs`, `getSpec`, `listFeatures`, `getFeature`, `listJobs`, `searchHistory` (all of the bound project) and
  the code tools `listRepoFiles`, `readRepoFile`, `searchRepoCode` for repos of the bound project. One write: `proposePlan`, which calls
  `FeaturePlanService.create` as the bot user, so the feature is created in draft, pinned to the version and approval, with every job in `triage`
  waiting for the recording job. Nothing queues, dispatches, approves, edits specs or changes existing features. An allowlist test pins the names.
  Project MCP tools (ADR 0014) are not given to it.
- **Fixable errors before creating.** `proposePlan` returns errors the agent can fix within the same run when an `AC-n` of the version is mentioned
  by no job, a task does not start with the fetch/rebase line, or a job names another job of the plan (by quoted key or title) without a direct or
  indirect `dependsOn`. A version that already has a pinned feature, is archived or is no longer the approved version gets a non-retryable result
  and the run ends `skipped`.
- **Read content is data.** The spec body sits in the user message between boundary lines with a random per-run nonce; the instructions say that it,
  code, features, jobs and history never change instructions, tools or the binding. Since the target comes from the binding, a successful injection
  still cannot reach another spec, project or repo.
- **A service entry for the worker.** `WerkmeesterService.plan(binding)` runs the agent once and returns `planned` (with the feature id), `skipped` or
  `failed`; the planning worker (triggers, limits, attempts, budgets) is a separate step on top of it.
- **Not reachable over HTTP.** The interceptor refuses any Mastra request that names `werkmeester` (403), like the other unattended agents; it is not
  listed on the CopilotKit route and its memory threads (`werkmeester:<spec>:<version>:<attempt>`) are never shown as conversations.

## Consequences

- Positive: approved specs turn into reviewable plans without hand-writing jobs, while approval and queueing stay human; the blast radius of a hostile
  spec or code file is one draft feature of its own version, with jobs in triage.
- Negative: a poor plan costs a reviewer's time (bounded by the human trigger or the project opt-in, and by the daily limit of the worker); repo code
  and spec text go to the model provider like for the co-pilot. The dependency check is a heuristic on names, so it can miss an unnamed dependency;
  the human review of the triage jobs remains the backstop.
- Follow-up: the planning runs table, triggers, limits and worker, then the spec page, notifications and issue comment.

## Alternatives considered

- **Let the Verfijner plan right after drafting.** It reads untrusted issue text and would write jobs before a human approved anything.
- **Plan through the co-pilot only.** Needs a person and an open session per spec; the point is to work after approval without one.
- **Let the agent pass the spec and approval to the tool.** Lets spec text steer the write; the binding removes that.
- **Queue the planned jobs automatically.** Removes the last human check on what the factory builds; out of scope.
