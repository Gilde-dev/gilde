# 0007. Let the Verkenner scout create triage jobs without approval

- **Status:** Accepted
- **Date:** 2026-10-27
- **Deciders:** agent job d8874020-3f72-48cf-9548-5aab9f8147ac (task of the Verkenner feature), reviewed in its PR
- **Supersedes:** the approval clause of [0004](0004-copilot-mastra-agent-in-api.md) ("only approval-gated tools can create data; any new state-changing tool must also use `requireApproval`"), for the Verkenner scout only
- **Related:** [docs/verkenner-signals.md](../verkenner-signals.md); README "Verkenner"

## Context

ADR 0004 gives the human co-pilot tools that create data (`createJob`, `createPlannedFeature`) and requires every state-changing tool
to suspend for the user's approval (`requireApproval: true`), enforced by the framework. `AGENTS.md` repeats this as a rule for all
co-pilot tools.

The Verkenner is a second Mastra agent in the same instance. It is not a conversation: it runs unattended, woken by notifications about
what happened in a project, and nobody is there to approve a tool call. An approval interrupt in an unattended run would only suspend it
forever. The feature wants it to turn well-supported observations into suggested work, which a human then accepts or discards.

## Decision

- Exactly one tool of one agent is exempt from `requireApproval`: the scout's `suggestJob` (built in a later job of the Verkenner
  feature), which may create a job **in status `triage`**, acting as one dedicated existing bot user (`SCOUT_USER_EMAIL`).
- The human gate for such a job is triage itself: only a human can queue, start, edit or cancel it. The scout has no tool that enqueues,
  starts, edits, cancels or otherwise transitions a job, creates features or lessons, or applies anything.
- The exemption is bounded by the server, not by the prompt: a per-project daily quota, a permanent rule against repeating an evidence
  set, a rule against titles of open jobs, and a required, validated evidence list. Those limits belong to the `suggestJob` job.
- Everything else stays as ADR 0004 says. The human co-pilot (`gilde`) keeps `requireApproval` on `createJob` and
  `createPlannedFeature`, and a new state-changing tool of `gilde` still needs approval. The scout is unreachable over HTTP (the context
  interceptor refuses it on every Mastra route) and runs only with a server-issued project binding, so no user can use the exemption.
- This job (the first of the feature) adds no creating tool at all: the scout has read tools and its inbox only.

## Consequences

- Positive: the scout can do its one job unattended; the approval rule stays simple for humans; the exception is a single named tool.
- Negative: for this tool the guarantee moves from the framework (approval interrupt) to server-side limits and triage, which have to be
  tested well. A wrong suggestion costs a human a look at the triage lane.
- Follow-up: the `suggestJob` job must test that the scout cannot enqueue or change anything and that the limits hold under concurrency.
  Any further unattended mutation needs its own ADR.

## Alternatives considered

- **Approval for the scout too** — an unattended run cannot answer it; it would never create anything.
- **The scout only writes text and a human creates the job** — safe, but the point is to put the suggestion in the board's triage lane
  with its evidence; a pasted text is lost in a chat.
- **Give it the API key of a person** — impersonates a human and blurs who created the job; a dedicated bot user is attributable.
