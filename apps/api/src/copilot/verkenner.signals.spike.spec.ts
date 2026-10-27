import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createNotificationInboxTool, dispatchDueNotifications } from '@mastra/core/notifications';
import type { NotificationsStorage } from '@mastra/core/storage';
import { LibSQLStore } from '@mastra/libsql';
import { PostgresStore } from '@mastra/pg';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';

/**
 * Executable spike for the Verkenner: proves, with the installed @mastra/core and a real LibSQL store (no network,
 * no paid model), the signal APIs the scout is built on. The findings are written down in docs/verkenner-signals.md;
 * these tests are the regression guard when @mastra/core is upgraded.
 */

interface PromptPart { type: string; text?: string }
interface PromptMessage { role: string; content: string | PromptPart[] }

/** A deterministic AI SDK v2 model: answers 'ok' and records the prompt of every call. */
function stubModel() {
    const prompts: PromptMessage[][] = [];
    const model = {
        specificationVersion: 'v2' as const,
        provider: 'stub',
        modelId: 'stub',
        supportedUrls: {},
        doGenerate: async () => { throw new Error('stub model only streams'); },
        doStream: async (options: { prompt: PromptMessage[] }) => {
            prompts.push(options.prompt);
            return {
                stream: new ReadableStream({
                    start(controller) {
                        controller.enqueue({ type: 'stream-start', warnings: [] });
                        controller.enqueue({ type: 'text-start', id: 't1' });
                        controller.enqueue({ type: 'text-delta', id: 't1', delta: 'ok' });
                        controller.enqueue({ type: 'text-end', id: 't1' });
                        controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
                        controller.close();
                    },
                }),
            };
        },
    };
    const text = () => prompts.map((p) => p.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((c) => c.text ?? '').join(''))).join('\n'));
    return { model, prompts, text };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
    const start = Date.now();
    while (!(await check())) {
        if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
        await sleep(25);
    }
}

interface Backend { storage: MastraCompositeStore; cleanup: () => Promise<void> }

const backends: Array<{ name: string; skip: boolean; create: () => Backend }> = [
    {
        name: 'LibSQL file',
        skip: false,
        create: () => {
            const dir = mkdtempSync(join(tmpdir(), 'verkenner-spike-'));
            return { storage: new LibSQLStore({ id: 'spike', url: `file:${join(dir, 'spike.db')}` }), cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
        },
    },
    {
        // Opt-in: needs a reachable Postgres, e.g. VERKENNER_SPIKE_PG_URL=postgres://user:pw@localhost:5432/db (see docs/verkenner-signals.md).
        name: 'PostgresStore',
        skip: !process.env.VERKENNER_SPIKE_PG_URL,
        create: () => {
            const schemaName = `verkenner_spike_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
            const storage = new PostgresStore({ id: 'spike', connectionString: process.env.VERKENNER_SPIKE_PG_URL!, schemaName });
            return {
                storage,
                cleanup: async () => {
                    // A fresh connection: the test may already have shut the Mastra instance (and its pool) down.
                    const admin = new PostgresStore({ id: 'spike-admin', connectionString: process.env.VERKENNER_SPIKE_PG_URL! });
                    await (admin as unknown as { pool: { query(sql: string): Promise<unknown> } }).pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
                    await admin.close();
                    await storage.close().catch(() => undefined);
                },
            };
        },
    },
];

describe.each(backends)('Verkenner signals spike (real @mastra/core + $name)', ({ skip, create }) => {
    if (skip) { it.skip('needs VERKENNER_SPIKE_PG_URL', () => {}); return; }

    let backend: Backend;
    let storage: MastraCompositeStore;
    let inbox: NotificationsStorage;
    const thread = { resourceId: 'scout-user', threadId: 'verkenner:project-1' };

    beforeEach(async () => {
        backend = create();
        storage = backend.storage;
        await storage.init();
        inbox = (await storage.getStore('notifications')) as NotificationsStorage;
    });
    afterEach(async () => { await backend.cleanup(); });

    function build(options: { dispatch?: { enabled: boolean; cron?: string; batchSize?: number }; policy?: ConstructorParameters<typeof Agent>[0]['notifications'] } = {}) {
        const stub = stubModel();
        const agent = new Agent({
            id: 'verkenner',
            name: 'verkenner',
            instructions: 'test',
            model: stub.model as never,
            memory: new Memory({ storage, options: { lastMessages: 20, semanticRecall: false } }),
            tools: { notificationInbox: createNotificationInboxTool({ storage: inbox }) },
            notifications: options.policy,
        });
        const mastra = new Mastra({
            agents: { verkenner: agent },
            storage,
            ...(options.dispatch ? { notifications: { dispatch: options.dispatch } } : {}),
        });
        return { mastra, agent: mastra.getAgent('verkenner'), stub };
    }

    it('the storage has a notifications domain (LibSQL)', () => {
        expect(inbox).toBeDefined();
        expect(typeof inbox.createNotification).toBe('function');
    });

    it('sendNotificationSignal persists an inbox record and a high notification wakes an idle thread', async () => {
        const { agent, stub } = build();
        const result = await agent.sendNotificationSignal(
            { source: 'gilde', kind: 'run-blocked', priority: 'high', summary: 'Run r1 of job j1 is blocked (repo a/b)', payload: { jobId: 'j1', runId: 'r1', repo: 'a/b' }, dedupeKey: 'run-blocked:r1' },
            thread,
        );

        expect(result.record).toMatchObject({ source: 'gilde', kind: 'run-blocked', priority: 'high', threadId: thread.threadId, resourceId: thread.resourceId, dedupeKey: 'run-blocked:r1' });
        expect(result.decision.action).toBe('deliver');
        const accepted = await result.accepted;
        expect(accepted?.action).toBe('wake');

        await until(() => stub.prompts.length > 0);
        expect(stub.text().join('\n')).toMatch(/<notification [^>]*kind="run-blocked" priority="high" source="gilde" status="delivered" type="run-blocked">/);
        expect(stub.text().join('\n')).toContain('Run r1 of job j1 is blocked');

        const stored = await inbox.listNotifications({ threadId: thread.threadId, source: 'gilde' });
        expect(stored).toHaveLength(1);
        expect(stored[0].payload).toEqual({ jobId: 'j1', runId: 'r1', repo: 'a/b' });
        await until(async () => (await inbox.getNotification({ threadId: thread.threadId, id: stored[0].id }))?.status === 'delivered');
    });

    it('the same dedupeKey coalesces into one record and does not deliver twice', async () => {
        const { agent, stub } = build({ policy: { deliveryPolicy: { priorities: { low: 'summarize' } } } });
        const event = { source: 'gilde', kind: 'lesson-new', priority: 'low' as const, summary: 'New lesson l1', dedupeKey: 'lesson-new:l1' };
        const first = await agent.sendNotificationSignal(event, thread);
        const second = await agent.sendNotificationSignal(event, thread);

        expect(second.record.id).toBe(first.record.id);
        const stored = await inbox.listNotifications({ threadId: thread.threadId });
        expect(stored).toHaveLength(1);
        expect(stored[0].coalescedCount).toBeGreaterThanOrEqual(2);
        expect(stub.prompts).toHaveLength(0);
    });

    it('dedupeKey only coalesces records that are still pending: a delivered or seen record is not reused', async () => {
        const { agent, stub } = build();
        const event = { source: 'gilde', kind: 'run-blocked', priority: 'high' as const, summary: 'Run r1 is blocked', dedupeKey: 'run-blocked:r1' };
        const first = await agent.sendNotificationSignal(event, thread);
        await first.accepted;
        await until(async () => (await inbox.getNotification({ threadId: thread.threadId, id: first.record.id }))?.status === 'delivered');
        await until(() => stub.prompts.length === 1);

        // The same event again after delivery creates a second record and wakes again: the native inbox alone is not
        // restart-safe dedupe. Job 2 therefore keeps a durable application receipt and publishes at most once per event.
        const again = await agent.sendNotificationSignal(event, thread);
        expect(again.record.id).not.toBe(first.record.id);
        expect(await inbox.listNotifications({ threadId: thread.threadId, status: ['pending', 'delivered', 'seen'] })).toHaveLength(2);
        await again.accepted;
    });

    it('a low notification does not wake an idle thread; a configured summary decision stays pending until dispatch emits <notification-summary>', async () => {
        const { mastra, agent, stub } = build({
            policy: { deliveryPolicy: { priorities: { high: 'deliver' }, decide: ({ record }) => (record.priority === 'low' || record.priority === 'medium' ? { action: 'summarize', summaryAt: new Date(Date.now() + 60_000), reason: 'daily summary' } : undefined) } },
        });
        const low = await agent.sendNotificationSignal({ source: 'gilde', kind: 'lesson-new', priority: 'low', summary: 'New lesson l1', dedupeKey: 'lesson-new:l1' }, thread);
        const medium = await agent.sendNotificationSignal({ source: 'gilde', kind: 'review-changes-requested', priority: 'medium', summary: 'Changes requested on job j2', dedupeKey: 'review:rv1' }, thread);

        expect(low.decision.action).toBe('summarize');
        expect(medium.decision.action).toBe('summarize');
        expect(stub.prompts).toHaveLength(0);
        const pending = await inbox.listNotifications({ threadId: thread.threadId, status: 'pending' });
        expect(pending).toHaveLength(2);
        expect(pending.every((r) => r.summaryAt !== undefined)).toBe(true);

        // Not due yet: nothing is dispatched.
        const early = await dispatchDueNotifications({ mastra, storage: inbox, now: new Date() });
        expect(early.delivered).toHaveLength(0);
        expect(stub.prompts).toHaveLength(0);

        // Due: the dispatcher emits one summary signal for the thread and wakes it.
        const due = await dispatchDueNotifications({ mastra, storage: inbox, now: new Date(Date.now() + 120_000) });
        expect(due.signals.length).toBeGreaterThan(0);
        await until(() => stub.prompts.length > 0);
        const prompt = stub.text().join('\n');
        expect(prompt).toContain('<notification-summary pending="2"');
        expect(prompt).toContain('gilde: 2');
        // Records stay pending and readable after a summary.
        const after = await inbox.listNotifications({ threadId: thread.threadId, status: 'pending' });
        expect(after).toHaveLength(2);
        expect(after.every((r) => r.summaryAt === undefined && r.summarySignalId)).toBe(true);
    });

    it('Mastra({ notifications: { dispatch } }) creates the scheduled dispatcher once a notification is deferred', async () => {
        const { mastra, agent } = build({
            dispatch: { enabled: true, cron: '0 6 * * *', batchSize: 50 },
            policy: { deliveryPolicy: { priorities: { low: { action: 'summarize', summaryAt: new Date(Date.now() + 3_600_000) } } } },
        });
        // Lazy: no schedule until something is deferred.
        const schedules = (await storage.getStore('schedules'))!;
        expect(await schedules.listSchedules()).toHaveLength(0);

        await agent.sendNotificationSignal({ source: 'gilde', kind: 'lesson-new', priority: 'low', summary: 'New lesson l1', dedupeKey: 'lesson-new:l1' }, thread);
        await until(async () => (await schedules.listSchedules()).length > 0);

        const [row] = await schedules.listSchedules();
        expect(row.id).toBe('__mastra_notification_dispatch');
        expect(row.cron).toBe('0 6 * * *');
        expect(mastra.getWorkflow('__mastra_notification_dispatcher' as never)).toBeDefined();
        await mastra.shutdown?.();
    });

    it('createNotificationInboxTool lists and reads inbox records for the thread', async () => {
        const { agent } = build({ policy: { deliveryPolicy: { priorities: { low: 'summarize' } } } });
        await agent.sendNotificationSignal({ source: 'gilde', kind: 'lesson-new', priority: 'low', summary: 'New lesson l1', dedupeKey: 'lesson-new:l1' }, thread);
        const tool = createNotificationInboxTool({ storage: inbox });
        expect(tool.id).toBe('notification-inbox');
        const out = (await tool.execute!({ action: 'search', query: 'lesson', threadId: thread.threadId } as never, {} as never)) as { notifications?: Array<{ summary: string }> };
        expect(JSON.stringify(out)).toContain('New lesson l1');
    });

    it('sendStateSignal needs an existing thread (bootstrap), skips the same cacheKey and mode, and accepts a changed cacheKey', async () => {
        const { agent } = build();
        await expect(agent.sendStateSignal({ id: 'board', mode: 'snapshot', cacheKey: 'board:0', contents: 'x' }, { ...thread, ifIdle: { behavior: 'persist' } })).rejects.toThrow(/could not load thread/);

        const memory = (await agent.getMemory())!;
        await memory.createThread({ ...thread, title: 'Verkenner project-1' });
        const state = (cacheKey: string) => ({ id: 'board', mode: 'snapshot' as const, cacheKey, contents: `Board ${cacheKey}`, value: { queued: 1 } });

        const first = await agent.sendStateSignal(state('board:1'), { ...thread, ifIdle: { behavior: 'persist' } });
        expect(first.skipped).not.toBe(true);
        if (!first.skipped) await first.persisted;

        const same = await agent.sendStateSignal(state('board:1'), { ...thread, ifIdle: { behavior: 'persist' } });
        expect(same).toEqual({ skipped: true, reason: 'unchanged' });

        const changed = await agent.sendStateSignal(state('board:2'), { ...thread, ifIdle: { behavior: 'persist' } });
        expect(changed.skipped).not.toBe(true);
    });
});
