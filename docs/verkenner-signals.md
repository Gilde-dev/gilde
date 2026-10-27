# Verkenner: verified Mastra signal APIs

Findings of the signals spike for the Verkenner (scout) feature. Everything below was run against the installed
`@mastra/core` **1.79.0** (the pinned version; nothing was upgraded) with real storage and a deterministic stub model, no network
and no paid inference. The executable record is `apps/api/src/copilot/verkenner.signals.spike.spec.ts`; when `@mastra/core` is
upgraded, that spec is the first thing to re-run. The docs it follows are in the package:
`node_modules/@mastra/core/dist/docs/references/` (`docs-harness-signals.md`, `docs-harness-signal-providers.md`,
`reference-signals-create-notification-inbox-tool.md`, `reference-agents-agent.md`, `reference-core-mastra-class.md`).

## What was run where

| Backend | How | Result |
|---|---|---|
| LibSQL file store (`@mastra/libsql`) | always, in `pnpm test` | all spike tests pass |
| Postgres 16 (`PostgresStore` from `@mastra/pg`) | **executed**: a local cluster, `VERKENNER_SPIKE_PG_URL=postgres://postgres@127.0.0.1:5433/spike pnpm --filter @gilde/api test -- verkenner.signals.spike` (each test in its own schema, dropped afterwards) | the same tests pass |

The Postgres run is opt-in because CI has no Postgres service: without `VERKENNER_SPIKE_PG_URL` the Postgres half is skipped (one
`skip` entry in the report) and nothing claims it passed. Both stores expose the domain through `storage.getStore('notifications')`
(source: `src/storage/domains/notifications` in `@mastra/libsql` and `@mastra/pg`); the in-memory
`InMemoryNotificationsStorage` also exists but is not used by Gilde. Neither store lacks notification support, so the feature is
**not blocked**.

To reproduce the Postgres run locally: any Postgres 16, an empty database, then the command above (the user needs `CREATE SCHEMA`).

## Exact imports and options

```ts
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createNotificationInboxTool, dispatchDueNotifications, defaultNotificationDeliveryDecision } from '@mastra/core/notifications';
import type { NotificationsStorage } from '@mastra/core/storage';
```

- **Storage**: the `Mastra` instance needs `storage` (Gilde: `MemoryInfrastructure.storage`). Notification storage is
  `await storage.getStore('notifications')`; `await storage.init()` creates the tables (Mastra owns them, no TypeORM migration).
- **Memory is required.** `agent.sendStateSignal` throws `sendStateSignal requires Mastra memory` for an agent without `memory`, and
  `sendStateSignal could not load thread <id>` for a thread that does not exist. `sendNotificationSignal` to an idle thread that does
  not exist yet works (the wake creates it). Gilde therefore creates the project thread first (`ScoutThreads.ensureThread`).
- **`agent.sendNotificationSignal(notification, options)`**
  - `notification`: `source`, `kind`, `summary` (required); `priority` (`'low' | 'medium' | 'high' | 'urgent'`, default medium),
    `payload`, `sourceId`, `dedupeKey`, `coalesceKey`, `attributes`, `metadata`.
  - `options`: `{ resourceId, threadId, ifIdle?: { streamOptions } }`.
  - Returns `{ record, decision, runId?, signal?, persisted?, accepted? }`; `accepted` resolves to `{ action: 'wake' | 'deliver' | 'persist' | 'discard' }`.
  - The record is persisted before anything is delivered (`record.threadId/resourceId/dedupeKey/payload` as sent).
- **Delivery policy** (constructor option of the agent): `new Agent({ notifications: { deliveryPolicy } })` with
  `{ default?, priorities?: { low|medium|high|urgent: action | decision }, sources?: Record<string, ...>, decide?: (input) => decision | undefined }`.
  Actions: `'deliver' | 'queue' | 'defer' | 'summarize' | 'persist' | 'discard'`. A decision is
  `{ action, deliverAt?, summaryAt?, reason?, streamOptions?, hold? }`. `decide({ record, threadState: 'active' | 'idle', now })`
  runs when the notification is sent **and again** when the dispatcher picks the record up; at dispatch time only `streamOptions`
  and `hold` are honoured.
- **Default policy** (no `deliveryPolicy`): urgent delivers at once; high delivers at once when the thread is idle, otherwise a summary is
  emitted and the full delivery waits; medium delivers when idle and batches when active; low always batches into summaries.
- **Wake**: an idle thread with a delivered notification starts a stream; the model sees
  `<notification id=… kind="run-blocked" priority="high" source="gilde" status="delivered" type="run-blocked">summary text</notification>`
  and the record becomes `delivered`.
- **Summary**: a `summarize` decision with `summaryAt` keeps the record `pending` (nothing wakes the model). When `summaryAt` is
  due, `dispatchDueNotifications` emits **one** signal per thread:
  `<notification-summary pending="2" …>gilde: 2</notification-summary>`. The summarized records stay `pending` and readable; their
  `summaryAt` is cleared and `summarySignalId` set.
- **`dedupeKey`**: a second notification with the same `source`, thread and `dedupeKey` while the first is still **pending** is coalesced into
  that record (`coalescedCount` rises, no second record, no second delivery). Once the record is delivered or seen, the same key creates
  a **new** record and delivers again. So the native inbox is not restart-safe event dedupe by itself: a producer that can see the same
  event twice must also keep its own durable receipt (job 2).
- **Inbox tool**: `createNotificationInboxTool({ storage: <notifications store> })` has id `notification-inbox` and actions
  `list | read | markSeen | dismiss | archive | search`; `threadId` is an input and defaults to the current thread. `list` marks what it
  returns as seen. Gilde pins `threadId` to the bound project thread (`verkenner.tools.ts`).
- **Scheduled dispatch**: `new Mastra({ agents, storage, notifications: { dispatch: { enabled?: boolean, cron?: string, batchSize?: number } } })`.
  Dispatch is enabled by default (cron `*/1 * * * *`, batch 100). It is created lazily: no schedule row exists until the first deferred
  or summarized notification; then a row with id `__mastra_notification_dispatch` and the configured `cron` appears in
  `storage.getStore('schedules')`, driving the workflow `__mastra_notification_dispatcher`. The dispatcher decides *whether* a record
  is due (`summaryAt`/`deliverAt`), the cron only says how often it looks. `dispatchDueNotifications({ mastra, storage, now?, limit?, resourceId? })`
  runs one pass directly (used by the spike, deterministic).
- **Run context for deferred wakes**: `decision.streamOptions` (`{ memory: { resource, thread }, requestContext }`) is attached to the run a
  notification starts, also when the dispatcher starts it long after the send. This is how Gilde gives every scout run the
  server-issued project binding (`createMastra`, `scoutStreamOptions`). A wake for a thread without a derivable project gets no
  binding, and the scout tools then refuse to do anything.
- **`agent.sendStateSignal({ id, mode: 'snapshot' | 'delta', cacheKey, contents, value?, delta? }, { resourceId, threadId, ifIdle? })`**:
  a second call with the same `cacheKey` and mode while that state is current returns `{ skipped: true, reason: 'unchanged' }` and does
  not touch the thread; a changed `cacheKey` is accepted. With `ifIdle: { behavior: 'persist' }` the state is stored without waking the agent.
- **Shutdown**: `mastra.shutdown()` stops the scheduler and closes the store; Gilde calls it from a Nest `onModuleDestroy` hook only when
  the scout is on (`ScoutLifecycle`).

## Limits of the spike

- The stub model never calls a paid API, so nothing here says how well a real model behaves; it proves delivery, storage and context only.
- The cron itself was not waited on (one minute at best). The spike proves the schedule row and the dispatcher pass
  (`dispatchDueNotifications`), which is what the cron triggers, but not the wall-clock firing.
- Only one process was used. Multi-process behaviour (lease on wake, `hold`) is described in the Mastra docs but not exercised.
- Postgres was verified by running the spike against a local Postgres 16, not against the production database or a pgvector image.
- Native `dedupeKey` is not restart-safe once a record was delivered (see above); nothing was substituted for it in this job.

## Delivery findings used by event publishing (job 2)

Read from the installed `@mastra/core` 1.79.0 and exercised in `apps/api/src/copilot/scout-signal.service.spec.ts`:

- A `summarize` decision whose `summaryAt` is already due at send time emits the summary immediately for `medium` priority; Gilde therefore
  always schedules `summaryAt` in the future (the next summary hour) and never lets a decision be due when it is sent.
- The dispatcher calls the delivery policy once per summary, with the first due record, and `hold: true` skips the whole summary without counting
  an attempt. This is the point where Gilde claims the daily summary from the durable budget (and sends the board state first).
- A summary made only of `low` records is sent with `behavior: 'persist'`: it is stored but does not wake the agent.
- `record.metadata` is stored with the record and visible to the policy at send and at dispatch time; Gilde marks records whose wake it
  claimed with `metadata.wake = 'granted'`.
