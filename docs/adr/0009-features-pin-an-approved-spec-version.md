# 0009. Features pin an approved spec version and are created in one transaction

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** agent job 3aa449ca-5ecc-485e-b280-0161c7d23250 (job 4 of the spec-driven development feature), reviewed in its PR
- **Related:** [0004](0004-copilot-mastra-agent-in-api.md), [0007](0007-verkenner-scout-may-create-triage-jobs.md); README "Specs and planning"

## Context

Specs are versioned and only a verified human approves them. The co-pilot plans features, and until now it created the feature and each
job with separate service calls, undoing them with cancellations when a step failed. A plan made from a spec needs more than that: it
must say which approved version it is made from, keep saying so when later drafts and approvals arrive, and never end half created.

## Decision

- A feature may be planned from an approved spec version. The plan carries `specId` and an exact token, `{ version, approvalId }`. The
  version must be the spec's current approved version in the same project, and its recording job must be able to merge.
- The feature stores `spec_id`, `spec_version` and a `spec_pin` snapshot (exact body, hash, approval, recording) once, and never
  updates them (the entity columns are not updatable, and Postgres refuses changes). A later draft or approval never repins it. The free
  text `spec` of a feature stays, and features without a spec stay as they are.
- `FeaturePlanService` creates the feature, its pin, all jobs and all dependency edges in one transaction with one entity manager. For a
  spec-linked plan it runs under the spec's own write slot and validates the token again inside, so an approval or draft cannot slip in
  between the user's confirmation and the write. A failure leaves nothing behind; compensating cancellations are gone.
- Every job of a spec-linked plan depends on the pinned recording job and starts with the pinned spec context. A recording that is
  cancelled, rejected, parked, merged without work or superseded is a validation error, not a bypass. The recording is marked pinned, so
  a newer approval waits for it instead of replacing it.
- The co-pilot gets `listSpecs`, `getSpec` and `draftSpec` (approval-gated, `expectedVersion`, actor from the request context). It gets
  no approval tool, and the Verkenner gets none of these tools or the planning tools.

## Consequences

- A plan made from a version that was approved again meanwhile is refused (superseded) and has to be planned again; this is intended.
- Two features can pin the same version; the recording stays pinned by the first one, which protects it for both.
- The co-pilot's chat card refuses to save a draft whose comparison is loading, failed or stale, and refuses to approve a spec-linked
  plan whose pin is not current. The server checks again regardless.
- The Slack channels process has no approval UI, so these tools do nothing there; this is deliberate and no approval path is added.
