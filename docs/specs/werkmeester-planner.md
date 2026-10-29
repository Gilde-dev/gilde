## Goal

Turn an approved spec version into a reviewable feature plan without a human writing the jobs: a fourth bounded agent, the Werkmeester, drafts a feature with triage jobs pinned to that exact version, either automatically on approval (opt-in per project) or when a human clicks "Plan from spec". A human still reviews the plan and queues the jobs; nothing is dispatched automatically.

## Context

- Specs are versioned and immutable; only a verified human approves a version, which creates a recording job that writes `docs/specs/<slug>.md` (ADR 0009). Planned features pin an approved version through `FeaturePlanService` (`copilot/feature-plan.service.ts`), which validates the plan, creates the feature in draft and all jobs in triage with dependencies in one transaction, and makes implementation jobs wait for the recording job.
- Gilde has three Mastra agents: the co-pilot (`gilde`, interactive, state changes need the approval card), the Verkenner (`verkenner`, unattended, read plus triage `suggestJob`, ADR 0007) and the Verfijner (`verfijner`, unattended, drafts specs from issues, ADR 0013). Unattended agents run under a bot user, are bound server-side to their target and are refused on Mastra HTTP routes.
- Drafting a spec and planning work are separate trust boundaries: the approval sits between them, and the agent that reads untrusted issue text (the Verfijner) must not also create jobs. The Werkmeester only starts from a human-approved version.
- Earlier dependency chains broke when jobs that build on each other had no explicit dependency; the plan must encode them.
- Assumption: the Werkmeester runs under its own bot user (`PLAN_USER_EMAIL`), separate from the Verkenner and Verfijner, so its plans are attributable.
- Assumption: jobs are planned in the spec's repo by default; the Werkmeester may plan jobs in other repos of the same project when the spec's Behaviour clearly needs them.

## Behaviour

Triggers. When a spec version is approved in a project with `autoPlan` enabled (project setting, off by default), Gilde queues a planning run for that version. On the spec page a verified human can also click "Plan from spec" on an approved version at any time, regardless of `autoPlan`. A version that already has a feature pinned to it is never planned again; for a newer approved version of a spec whose earlier version is already planned, the Werkmeester does not create a second plan but leaves a note on the spec ("v3 approved; feature X is pinned to v2") for the human to decide.

The run. A worker picks queued planning runs one at a time per project, within a daily limit (`PLAN_DAILY_LIMIT`, default 5 per project) and not while the project's or the global budget is hard. It runs the Werkmeester once with a server-issued binding to exactly that spec version (project, spec id, version, approval id). The Werkmeester reads the spec body and its acceptance criteria, the relevant code (read-only code tools for the project's repos), existing features and jobs of the project, and history, then proposes a plan through its single write tool.

The write tool. `proposePlan` takes a title, a short feature description and jobs (key, repo, title, task, acceptance criteria, dependencies by key) and passes them to `FeaturePlanService` with the bound spec version and approval, so the feature is pinned and jobs wait for the recording job. The spec, version and approval come from the binding, never from input. Before creating, it checks that every acceptance criterion of the spec (`AC-n`) is referenced by at least one job's task or criteria, that dependencies are explicit where a job builds on another job's code, and that every task starts with the fetch/rebase instruction; violations come back as fixable errors within the same run, like spec parser errors for the Verfijner. The result is a draft feature with triage jobs created by the Werkmeester bot user. It never queues, dispatches, approves, edits specs or changes other features.

Outcomes. A planning run ends as `planned` (with the feature id), `skipped` (already planned, not approved anymore, archived) or `failed` after 2 attempts with a short reason. The spec page shows the planning status and links to the feature. A notification `spec.planned` (and `spec.plan_failed`) goes through the existing outbox; when the spec came from an issue, the intake status comment shows "planned" as it already does for features planned by humans.

Safety. Spec text, code, history and any other read content are passed as delimited data; nothing in them can change the Werkmeester's instructions, tools or binding. It is refused on every Mastra HTTP route and has no tools beyond its allowlist.

## Acceptance criteria

- AC-1: With `autoPlan` enabled on a project, approving a spec version queues exactly one planning run for that version; with `autoPlan` off nothing is queued, and a verified human can always start one with "Plan from spec" on an approved version.
- AC-2: A version that already has a pinned feature is never planned again, and a newer approved version of an already planned spec produces a note on the spec instead of a second plan.
- AC-3: A worker runs planning one at a time per project within `PLAN_DAILY_LIMIT` (default 5, invalid values fail closed) and not while a project or global budget is hard; runs end as planned, skipped or failed after 2 attempts.
- AC-4: The Werkmeester runs under a bot user from `PLAN_USER_EMAIL` with a server-issued binding to one spec version; its only write tool is `proposePlan`, and an explicit allowlist test proves it cannot queue, dispatch, approve, edit specs or touch other features.
- AC-5: `proposePlan` creates the plan through `FeaturePlanService` pinned to the bound version and approval, with the feature in draft and all jobs in triage waiting for the recording job; spec, version and approval can never come from tool input.
- AC-6: `proposePlan` rejects with fixable errors a plan where an acceptance criterion of the spec is not referenced by any job, a job builds on another job's code without a dependency, or a task does not start with the fetch/rebase instruction.
- AC-7: The spec page shows the planning status with a link to the feature, `spec.planned` and `spec.plan_failed` notifications are sent through the outbox, and an issue-backed spec's status comment shows planned.
- AC-8: Read content is passed as delimited untrusted data and tests with a fake model show that instructions in a spec, code or history cannot change the Werkmeester's tools or binding; it is refused on every Mastra HTTP route.
- AC-9: An ADR records the Werkmeester as the fourth bounded unattended writer (triage-only plans from human-approved versions) next to ADR 0007, 0010 and 0013, and the README documents setup and limits.

## Out of scope

- Queueing or dispatching planned jobs automatically.
- Re-planning or editing an existing feature when a newer spec version is approved.
- Planning from unapproved drafts or from free text without a spec.
- Estimating effort or cost of a plan.

## Open questions

None.
