# 0008. Full-replacement PUT for updates; controllers depend on services and return DTOs

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** agent job 6c4b8b5c, reviewed by the pull request reviewer
- **Related:** [0004](0004-copilot-mastra-agent-in-api.md) (tools call services and return DTOs)

## Context

Five resources (job, feature, project, repo, lesson) were updated with `PATCH` routes whose zod schemas were `.partial()` or had every field optional, with a `refine` for "at least one field". Omission meant "keep", `null` meant "clear", and the services merged whatever arrived. This worked, but:

- the contract of a request depended on which keys were present, which made the web forms, the budget settings and the service invariants harder to reason about (for example the skills library was only revalidated when one of its keys was present);
- `.partial()` pushed the repo towards "no `.default()` in schemas that get `.partial()`", a rule that only existed to keep omitted keys from being overwritten;
- several controllers had grown past routing: `JobSendBackController` injected the job repository, and a number of routes returned interfaces or inline object types defined in services instead of DTOs, so the wire format of dispatch, reconcile, workspace, attribution, history, webhook and OTLP responses was not described next to the other DTOs.

## Decision

- Updates use `PUT` with full replacement of the resource's updatable fields. Each of the five resources has an explicit `Replace…Schema` (and `Replace…Dto`) with every updatable field as a required key, no `.partial()`, no `.default()`. Nullable fields are required keys that accept `null`, which clears them. Identity and server-managed fields (`slug`, `fullName`, `paused`, status, manifest fields, ids) are not part of the shape. There are no `PATCH` routes and no compatibility aliases. Job dependencies and state actions keep their own endpoints.
- Services keep all business rules. Where a full body would otherwise change a rule, the service compares with the stored resource: a job's content may only differ in `triage`, a queued job may change its feature when the content is resent unchanged, an unchanged feature link or skills library is not revalidated.
- The web client builds each body from the most recently loaded resource (`projectReplacement`, `repoReplacement`, `jobReplacement`, `featureReplacement`, `lessonReplacement` in `lib/api.ts`), overlays only the user's edits and never sends `undefined`.
- Controllers depend on services only: no entity imports, repositories, `DataSource` or `EntityManager`. Every controller route returns a DTO type from a `*.dto.ts` file that is declared as `z.infer<typeof Schema>` (or `void` for 204). Response DTOs are described by zod schemas but responses are not parsed at runtime, so established wire formats do not change.
- Request schemas have no `.default()`. Query fallbacks (page size, window in days) are applied in the service that uses them.
- `apps/api/src/architecture.spec.ts` scans every `*.controller.ts` with the TypeScript compiler API and fails, with file and line, on any of the above.

## Consequences

- Positive: one request contract per update; the forms and the budget settings no longer depend on omission semantics; response shapes live next to the other DTOs; the controller layer is enforced to be thin by a test instead of by review.
- Negative: this is a breaking change of the request contract. Any client that sent partial `PATCH` bodies (scripts, API-key users) must switch to `PUT` with the complete shape.
- Negative: lost updates. If two editors load the same resource and each saves a section, the last write wins. A complete body carries the values its client loaded, so a stale client overwrites changes made in between for the fields it did not edit; there is no ETag, version column or other optimistic concurrency check, and this decision does not claim to provide one. Clients use the latest loaded values (forms read the polled resource at save time), which narrows but does not close the window.
- Negative: a lesson with the legacy `skill` target kind cannot be sent back as is (the API rejects it), so editing such a lesson in the web UI clears that kind.
- Follow-up: if lost updates become a real problem, add versioning in a new ADR.

## Alternatives considered

- **Keep `PATCH` with partial bodies** — simplest for clients, but keeps the omission semantics this decision removes.
- **Support both `PATCH` and `PUT`** — doubles the contract and the tests, and leaves `.partial()` in place.
- **Optimistic concurrency now (ETag or `updatedAt` precondition)** — would remove the lost-update trade-off, but is a larger API and UI change than this cleanup, and no editor has asked for it yet.
- **Allow controllers to read repositories for simple lookups** — shorter, but spreads persistence rules across layers; the one existing case (send-back) moved to `JobEventsService.sendBackById`.
