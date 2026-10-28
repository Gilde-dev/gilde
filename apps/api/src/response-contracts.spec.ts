import { describe, expect, it } from 'vitest';

import { BudgetStatusSchema } from './budget/budget.dto.js';
import { CopilotStatusSchema } from './copilot/copilot.dto.js';
import { DispatchStatusSchema } from './dispatch/dispatch.dto.js';
import { HealthResponseSchema } from './health/health.dto.js';
import { HistoryRunSummarySchema, HistorySearchResultSchema, HistoryStatusSchema } from './memory/history/history.dto.js';
import { OtlpExportResponseSchema } from './otel/agent-usage.dto.js';
import { ReconcileResultSchema } from './reconcile/reconcile.dto.js';
import { WorkspaceStatusSchema } from './repo/repo.dto.js';
import { AttributionResultSchema } from './usage/usage.dto.js';
import { WebhookResponseSchema } from './webhook/webhook.dto.js';
import { ApiKeyResponseSchema, CreatedApiKeySchema } from './api-key/api-key.dto.js';
import { CollectResultSchema, } from './lesson/lesson.dto.js';
import { JobPromptResponseSchema } from './job/job.dto.js';
import { PromoteSkillResponseSchema } from './skill/skill.dto.js';

/**
 * The response types are zod-inferred; the schemas describe the wire format that existed before (they do not parse
 * responses at runtime). These payloads pin the nested, nullable and optional variants of each.
 */
describe('response contracts', () => {
    const period = {
        scope: 'project', period: 'day', projectId: 'p', startsAt: '2026-03-10T00:00:00.000Z', resetsAt: '2026-03-11T00:00:00.000Z',
        spent: 5, pricedRows: 1, totalRows: 1, unpricedRows: 0, pricing: 'complete', incomplete: false, limit: 0, percent: null,
        softPct: 80, state: 'hard', reason: { kind: 'limit', variable: null, message: 'm' },
    };
    const blocker = { scope: 'project', projectId: 'p', period: 'day', kind: 'limit', variable: null, limit: 0, spent: 5, startsAt: 'a', resetsAt: 'b', message: 'm' };

    it('dispatch status: idle, ok and budget-stopped variants', () => {
        expect(DispatchStatusSchema.parse({ at: null, result: null })).toEqual({ at: null, result: null });
        const ok = { repoId: 'r', fullName: 'o/r', queued: 1, fired: 1, reason: 'none', detail: null, resetsAt: null, waitingOnDependencies: 0, waitingOnRevisions: 0, budget: null };
        const budget = { ...ok, fired: 0, reason: 'budget', detail: 'x', resetsAt: '2026-03-11T00:00:00.000Z', budget: { blockers: [blocker], recovery: 'reset', error: false } };
        const failed = { ...ok, fired: 0, reason: 'budget', budget: { blockers: [], recovery: 'unknown', error: true } };
        const status = { at: '2026-03-10T12:00:00.000Z', result: { fired: 1, failed: 2, repos: [ok, budget, failed] } };
        expect(DispatchStatusSchema.parse(status)).toEqual(status);
        for (const reason of ['repo_paused', 'project_paused', 'no_routine', 'no_manifest', 'no_slots', 'daily_limit']) {
            expect(DispatchStatusSchema.safeParse({ at: null, result: { fired: 0, failed: 0, repos: [{ ...ok, reason }] } }).success).toBe(true);
        }
        expect(DispatchStatusSchema.safeParse({ at: null, result: { fired: 0, failed: 0, repos: [{ ...ok, reason: 'busy' }] } }).success).toBe(false);
    });

    it('reconcile, workspace, attribution', () => {
        expect(ReconcileResultSchema.parse({ checked: 3, corrected: 1 })).toEqual({ checked: 3, corrected: 1 });
        const clone = { cloned: true, headSha: 'abc', fetchedAt: '2026-03-10T00:00:00.000Z', error: null };
        expect(WorkspaceStatusSchema.parse(clone)).toEqual(clone);
        expect(WorkspaceStatusSchema.parse({ cloned: false, headSha: null, fetchedAt: null, error: 'clone failed' })).toMatchObject({ error: 'clone failed' });
        const attribution = { skipped: false, sessionsExamined: 5, sessionsBySession: 1, sessionsByTimeWindow: 1, sessionsAmbiguous: 1, sessionsUnmatched: 2, rowsAttributed: 7, rowsUpgraded: 1 };
        expect(AttributionResultSchema.parse(attribution)).toEqual(attribution);
        expect(AttributionResultSchema.parse({ ...attribution, skipped: true, sessionsExamined: 0 }).skipped).toBe(true);
    });

    it('history: status with and without a pass, run summaries, search results', () => {
        const idle = {
            enabled: false, embeddings: false, reason: 'MEMORY_HISTORY_INDEX=off', indexName: 'history', indexedSources: 0, passInProgress: false,
            progress: { scanKind: null, phase: null, cursor: null }, passStartedAt: null, lastCompletedAt: null, lastError: null, lastErrorAt: null,
            consecutiveFailures: 0, stats: null,
        };
        expect(HistoryStatusSchema.parse(idle)).toEqual(idle);
        const running = { ...idle, enabled: true, embeddings: true, reason: null, passInProgress: true, progress: { scanKind: 'job', phase: 'scan', cursor: 'c' }, passStartedAt: '2026-03-10T00:00:00.000Z', stats: { indexed: 1, unchanged: 2, removed: 3, embeddedChunks: 4 } };
        expect(HistoryStatusSchema.parse(running)).toEqual(running);
        const stats = { indexed: 0, unchanged: 0, removed: 0, embeddedChunks: 0 };
        expect(HistoryRunSummarySchema.parse({ outcome: 'idle', batches: 0, stats })).toEqual({ outcome: 'idle', batches: 0, stats });
        expect(HistoryRunSummarySchema.parse({ outcome: 'failed', batches: 1, stats, error: 'boom' }).error).toBe('boom');
        expect(HistorySearchResultSchema.parse({ status: 'ok', results: [], indexComplete: true, suppressed: 0 }).status).toBe('ok');
        expect(HistorySearchResultSchema.parse({ status: 'unavailable', reason: 'off', results: [] })).toEqual({ status: 'unavailable', reason: 'off', results: [] });
    });

    it('OTLP: {} is full success, partialSuccess carries the rejection', () => {
        expect(OtlpExportResponseSchema.parse({})).toEqual({});
        const partial = { partialSuccess: { rejectedLogRecords: 2, errorMessage: 'bad' } };
        expect(OtlpExportResponseSchema.parse(partial)).toEqual(partial);
        expect(OtlpExportResponseSchema.parse({ partialSuccess: {} })).toEqual({ partialSuccess: {} });
    });

    it('webhook, health, copilot status, budget status', () => {
        expect(WebhookResponseSchema.parse({ result: 'pong' })).toEqual({ result: 'pong' });
        const down = { status: 'down', checks: { database: { status: 'down', error: 'x' } } };
        expect(HealthResponseSchema.parse(down)).toEqual(down);
        expect(HealthResponseSchema.parse({ status: 'up', checks: { database: { status: 'up' } } }).checks.database).toEqual({ status: 'up' });
        const copilot = { enabled: true, model: null, scout: { enabled: false, model: null } };
        expect(CopilotStatusSchema.parse(copilot)).toEqual(copilot);
        const budget = {
            evaluatedAt: 'now', global: { day: { ...period, scope: 'global', projectId: null }, week: { ...period, scope: 'global', projectId: null, period: 'week' } },
            project: { projectId: 'p', day: period, week: { ...period, period: 'week' } }, blockers: [blocker], hardBlocked: true, recovery: 'manual', recoversAt: null,
        };
        expect(BudgetStatusSchema.parse(budget)).toEqual(budget);
        expect(BudgetStatusSchema.parse({ ...budget, project: null, blockers: [], hardBlocked: false, recovery: 'none' }).project).toBeNull();
    });

    it('small DTOs keep their keys', () => {
        expect(CollectResultSchema.parse({ created: 2 })).toEqual({ created: 2 });
        expect(JobPromptResponseSchema.parse({ text: 't', instructionsVersion: null })).toEqual({ text: 't', instructionsVersion: null });
        expect(PromoteSkillResponseSchema.parse({ libraryJobId: null, cleanupJobId: 'j' })).toEqual({ libraryJobId: null, cleanupJobId: 'j' });
        const key = { id: 'i', name: 'n', prefix: 'p', createdAt: 'c', lastUsedAt: null, expiresAt: null };
        expect(ApiKeyResponseSchema.parse(key)).toEqual(key);
        expect(CreatedApiKeySchema.parse({ id: 'i', name: 'n', prefix: 'p', key: 'gk_x', expiresAt: null })).toMatchObject({ key: 'gk_x' });
    });
});
