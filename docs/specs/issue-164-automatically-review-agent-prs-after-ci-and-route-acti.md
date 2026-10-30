## Goal

Review agent PRs after CI passes, returning concrete problems to the coding agent before asking a human to review, with project opt-in, bounded cost, bounded revision rounds and a human override.

## Context

- Issue: https://github.com/Gilde-dev/gilde/issues/164
- `JobEventsService.workflowCompleted` currently moves green-CI jobs straight to `awaiting_review`; webhooks and reconciliation share this path. Send-back preserves the branch/PR and respects project `maxAttempts` and dispatch policies.
- `.github/workflows/agent-review.yaml` is a separate, label-triggered Claude review. It posts comments, not a GitHub review, and does not control job routing.
- Feature `specPin` contains immutable approved spec text. Agent runtime settings, kill switches, activity logs and project/global budgets already exist. Project `autoPlan` provides the pattern for an off-by-default policy toggle.
- The maintainer requests per-project `autoReview` opt-in and an incomplete “too large” result instead of reviewing a truncated diff; limits remain configurable in agent settings.

## Behaviour

Project opt-in. Add a persisted boolean `autoReview`, default false for existing and new projects, exposed through project API reads/writes and a Project settings policy toggle like `autoPlan`. Runtime configuration alone never enables automatic review. When the project has not opted in, retain today's CI-to-human path with an explicit skipped reason. An opted-in project also requires an enabled, configured reviewer runtime; otherwise use the same path with the appropriate skipped reason. Assumption: policy changes apply to subsequent CI observations, without retroactively starting reviews for jobs already awaiting human review.

Automatic gate. For an opted-in project's open, non-draft PR linked to a Gilde job, passing the existing tracked CI policy for the current head starts one automatic review before entering `awaiting_review` or emitting its notification. Webhook redelivery, reconciliation and concurrent observations must not duplicate reviews or revision rounds. Expose review-pending/running state in job details; no new board lane is required. A new head requires fresh CI and, while opted in, a fresh review. Results for an obsolete head, closed PR or superseded job state cannot route the job.

Review inputs. Use the persisted job task and acceptance criteria, the feature's pinned spec criteria when present, repository conventions in `AGENTS.md`, the full diff and necessary surrounding code/tests. Do not trust the PR body's checklist as the contract. Assess criterion coverage, correctness/security, meaningful tests, conventions and unjustified protected-path or scope changes. Show pinned criterion IDs and distinguish criteria relevant to this job from feature work assigned elsewhere; do not demand the whole feature in every PR. Assumption: conventions and reviewer instructions come from the trusted base revision, not PR modifications. Treat reviewed content as untrusted data; the reviewer cannot edit code, run PR-provided commands, change policies, approve specs or merge.

Input completeness. Check that the complete diff and required context fit within the configured input-token budget, including instructions and other review inputs. Never truncate or omit diff sections or required context to fit. If they do not fit, persist an incomplete result with reason “too large” and hand the job to `awaiting_review` with that reason, without automatic revision or a clean verdict. Preflight overflow must not invoke the model on a partial diff. If additional necessary context discovered during review exceeds the remaining budget, stop and mark the result incomplete “too large”; partial findings cannot drive automatic send-back. Upstream truncation or unavailable diff/context must likewise never count as a complete review.

Output and routing. Persist a structured verdict with criterion coverage (met, unmet, unverifiable or not applicable with explanation), blocking findings and non-blocking suggestions. Findings give evidence, file/line where applicable, impact and a requested fix. Missing evidence alone is not proof of a defect; incomplete inspection is not a clean verdict. Publish a GitHub PR review tied to the reviewed head, containing the verdict, coverage and findings, and retain its URL in Gilde. Assumption: use a COMMENT review rather than GitHub APPROVE/REQUEST_CHANGES; the controller owns routing and the human remains the final approver. Publish incomplete results as COMMENT reviews when GitHub is available, clearly labelled as incomplete rather than passed.

A complete review with no blocking findings moves the job to `awaiting_review` with the review attached and the normal notification. Concrete blocking findings requeue the job on its existing PR/branch with those findings in the next agent payload, through normal attempt and dispatch limits. Suggestions alone never trigger send-back. The review's own webhook must not trigger a second send-back.

Bounds and failures. Assumption: default to at most two automatic reviewer-initiated revision rounds per job, persisted across heads and restarts, also respecting project `maxAttempts`. When either limit prevents another revision, stop automation and park with the review and a clear reason. Assumption: each review defaults to a five-minute timeout, at most 12 model steps, 60,000 aggregate input tokens and 4,000 aggregate output tokens. Keep the timeout, step, token and automatic revision limits configurable and validated as finite positive integers in the reviewer's existing agent-settings API/UI; changes apply on subsequent reviews without restart. Bound context/tool results by refusing incomplete input, not silently truncating required review material. Register the reviewer with existing agent configuration/activity and environment kill-switch mechanisms, recording model, tokens and estimated cost where available. Respect project/global budget stops before model execution; revision dispatch retains existing gates.

Timeout, malformed output, unavailable context, budget refusal or GitHub publication failure produces a visible incomplete/error result, not a pass or automatic send-back. Hand these cases to `awaiting_review` with the failure reason; retain any completed findings and do not silently retry model calls for the same head. Document required GitHub review-write permissions. Keep the label-triggered workflow independent; its comments do not count as this gate's verdict.

Visibility and override. Job details show review status/history, reviewed SHA, coverage, findings, revision count, limits, failure/skip reason and GitHub review link. A verified human can override an automatic decision for the current green-CI head, with a required reason, moving it to `awaiting_review` and suppressing further automatic routing for that head. Permit this before a queued revision is dispatched, or from an automatically parked/review-pending job; reject stale heads, terminal jobs and active coding rounds. Cancel only the pending automatic revision, not running work. Record actor, time, reason and overridden result; never clear protected-path approval requirements, bypass CI or auto-merge. A new head invalidates the override.

## Acceptance criteria

- AC-1: In a project with `autoReview` enabled and a configured/enabled reviewer, green CI on a current, open, non-draft job PR invokes the gate before human-review readiness; duplicate webhook/reconcile observations start at most one model review and one routing action for that head.
- AC-2: Review inputs include persisted job criteria, the exact feature spec pin when present, trusted-base conventions and complete diff/test context; tests demonstrate that later spec versions and PR-body instructions cannot replace these inputs.
- AC-3: Persisted and published results include a verdict, criterion coverage and evidence-backed blocking findings separated from suggestions; feature criteria assigned elsewhere do not alone cause send-back.
- AC-4: A complete non-blocking result posts a head-bound GitHub COMMENT review and moves the job to `awaiting_review` with its link and normal notification. A blocking result supplies findings to a same-branch, same-PR revision without first notifying human-review readiness.
- AC-5: Automatic send-back respects the configured per-job revision limit (default two) and project attempt limits; exhaustion parks with findings and a reason. The review webhook cannot duplicate this action.
- AC-6: Finite positive timeout, step, input/output-token and revision limits can be saved through agent settings and take effect on subsequent reviews without restart; invalid values are rejected. Reviews enforce these limits, check budgets, honour kill switches and record usage/activity. Revision dispatch retains executor, pause, concurrency and budget gates.
- AC-7: Project opt-out, disabled/unconfigured runtime and each documented failure mode are visibly distinguished from a clean review; failures go to human review without automatic revision or repeated model calls for that head.
- AC-8: Job details expose review history, SHA, coverage, findings, limits, revision count, errors/skips including “too large”, and GitHub links; a reviewer can see why a job was returned.
- AC-9: Verified humans can override an eligible current-head automatic decision with an audited reason; bots/API keys, stale heads, terminal jobs and active coding rounds are rejected. Overrides neither bypass CI/protected-path approval nor survive a new head.
- AC-10: Race/restart tests cover head changes, PR closure, concurrent observations and overrides so stale results never change job routing. README documents project opt-in, setup, permissions, configurable limits, oversized-input handling, failures, override and separation from label-triggered reviews.
- AC-11: Existing and new projects default to `autoReview: false`. Project API reads/writes and the Project settings toggle persist it independently per project; configuring the runtime alone starts no reviews, and opted-out projects retain the CI-to-human path.
- AC-12: When the complete diff plus required context exceeds the input-token budget, the review is incomplete with reason “too large”, the job goes to `awaiting_review` without send-back, and no truncated diff is reviewed. Tests cover preflight overflow without a model call and overflow from additional required context during review; neither yields a clean verdict.

## Out of scope

- Automatic merge, replacing final human approval or bypassing protected-path gates.
- Automatically reviewing human PRs or using the label-triggered workflow as the routing authority.
- Reviewer code edits, arbitrary PR command execution, feature-wide acceptance sign-off, or unrelated agent/platform redesign.
- Reviewing sampled or truncated diffs to work around input limits.

## Open questions

None.
