import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { dispatchDueNotifications } from '@mastra/core/notifications';
import type { Mastra } from '@mastra/core/mastra';
import type { NotificationsStorage } from '@mastra/core/storage';
import { DataSource } from 'typeorm';

import { testMemoryInfrastructure } from '../memory/memory.testing.js';
import { ScoutSignalPublisher } from '../scout-signal/scout-signal.publisher.js';
import type { ScoutEvent } from '../scout-signal/scout-signal.events.js';
import { createMastra, SCOUT_DISPATCH_CRON, type ScoutSetup } from './copilot.mastra.js';
import { ScoutDispatchGate } from './scout-delivery-policy.js';
import { ScoutSignalReceipt } from './scout-signal-receipt.entity.js';
import { ScoutSignalService } from './scout-signal.service.js';
import { ScoutWakeDay } from './scout-wake-day.entity.js';
import { ScoutWakeBudgetService } from './scout-wake-budget.service.js';
import { ScoutWakeReader } from './scout-wake.reader.js';
import { scoutConfig } from './verkenner.config.js';
import { ScoutThreads } from './verkenner.threads.js';

const P1 = '3f2b8a4e-1c5d-4e7a-9b60-0d1e2f3a4b5c';
const JOB = '11111111-1111-4111-8111-111111111111';
const REPO = '22222222-2222-4222-8222-222222222222';
const BOT = { id: 'bot-user', name: 'Verkenner', email: 'verkenner@example.com' };
const env = { SCOUT_ENABLED: 'true', SCOUT_USER_EMAIL: BOT.email, SCOUT_MODEL: 'openai/scout-model', OPENAI_API_KEY: 'k' };

interface Part { type: string; text?: string }
interface Message { role: string; content: string | Part[] }

function stubModel() {
    const prompts: Message[][] = [];
    const model = {
        specificationVersion: 'v2' as const, provider: 'stub', modelId: 'stub', supportedUrls: {},
        doGenerate: async () => { throw new Error('stub model only streams'); },
        doStream: async (call: { prompt: Message[] }) => {
            prompts.push(call.prompt);
            return {
                stream: new ReadableStream({
                    start(c) {
                        c.enqueue({ type: 'stream-start', warnings: [] });
                        c.enqueue({ type: 'text-start', id: 't' });
                        c.enqueue({ type: 'text-delta', id: 't', delta: 'ok' });
                        c.enqueue({ type: 'text-end', id: 't' });
                        c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
                        c.close();
                    },
                }),
            };
        },
    };
    const text = () => prompts.map((p) => p.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((x) => x.text ?? '').join(''))).join('\n')).join('\n=====\n');
    return { model, prompts, text };
}

const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
    const start = Date.now();
    while (!(await check())) {
        if (Date.now() - start > ms) throw new Error('condition not met in time');
        await new Promise((r) => setTimeout(r, 25));
    }
};

const blocked = (runId: string): ScoutEvent => ({ type: 'run_outcome', outcome: 'blocked', jobId: JOB, runId, repoId: REPO });
const lesson = (id: string): ScoutEvent => ({ type: 'lesson_created', lessonId: id, jobId: JOB });
const review = (id: string): ScoutEvent => ({ type: 'changes_requested', jobId: JOB, repoId: REPO, feedbackId: id, prNumber: 7 });

describe('ScoutSignalService (real Mastra, LibSQL and TypeORM SQLite, stub model)', () => {
    let dir: string;
    let ds: DataSource;
    let clock: Date;
    let infra: ReturnType<typeof testMemoryInfrastructure>;
    let stub: ReturnType<typeof stubModel>;
    let mastra: Mastra;
    let service: ScoutSignalService;
    let budget: ScoutWakeBudgetService;
    let gate: ScoutDispatchGate;
    let inbox: NotificationsStorage;
    let globalHard: boolean | Error = false;
    const statusSnapshot = vi.fn();
    const featuresList = vi.fn();

    /** Builds everything a process start builds: this is also how a "restart" is simulated (same files, new objects). */
    async function boot(options: { maxWakes?: number; hour?: number } = {}) {
        stub = stubModel();
        gate = new ScoutDispatchGate();
        const config = scoutConfig({ ...env, SCOUT_MAX_WAKES_PER_DAY: String(options.maxWakes ?? 6), SCOUT_SUMMARY_HOUR_UTC: String(options.hour ?? 6) });
        if (!config.enabled) throw new Error('test setup');
        const setup: ScoutSetup = { config, user: BOT, model: stub.model, gate };
        infra = testMemoryInfrastructure({ url: `file:${join(dir, 'm.db')}` });
        await infra.storage.init();
        mastra = createMastra({ enabled: false, model: null, reason: 'x' }, {} as never, undefined, undefined, infra, undefined, setup);
        inbox = (await infra.storage.getStore('notifications')) as NotificationsStorage;
        const threads = new ScoutThreads(mastra, BOT, { getById: async (id) => ({ id }) });
        budget = new ScoutWakeBudgetService(ds.getRepository(ScoutWakeDay), { maxWakesPerDay: options.maxWakes ?? 6, summaryHourUtc: options.hour ?? 6 }, () => clock);
        service = new ScoutSignalService({
            mastra, threads, budget, receipts: ds.getRepository(ScoutSignalReceipt),
            jobs: { statusSnapshot }, features: { list: featuresList }, repos: { getById: async () => ({ fullName: 'acme/api' }) },
            inbox: async () => inbox, summaryHourUtc: options.hour ?? 6,
            globalBudgetHard: async () => { if (globalHard instanceof Error) throw globalHard; return globalHard; },
        });
        gate.bind({ now: () => budget.now(), summaryAt: (n) => service.summaryAt(n), allowSummary: (p) => service.allowSummary(p) });
    }

    const day = async () => ds.getRepository(ScoutWakeDay).findOneByOrFail({ projectId: P1, day: clock.toISOString().slice(0, 10) });
    const records = () => inbox.listNotifications({ threadId: `verkenner:${P1}` });
    const dispatch = () => dispatchDueNotifications({ mastra, storage: inbox, now: clock });

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'scout-signal-'));
        ds = await new DataSource({ type: 'better-sqlite3', database: join(dir, 'app.db'), entities: [ScoutSignalReceipt, ScoutWakeDay], synchronize: true }).initialize();
        clock = new Date('2030-03-10T05:00:00Z');
        globalHard = false;
        statusSnapshot.mockReset().mockResolvedValue({ counts: { queued: 2, parked: 1 }, parkedIds: [JOB] });
        featuresList.mockReset().mockResolvedValue([{ id: 'f1', status: 'active' }, { id: 'f2', status: 'done' }]);
        await boot();
    });
    afterEach(async () => {
        await mastra.shutdown?.();
        await ds.destroy();
        rmSync(dir, { recursive: true, force: true });
    });

    it('wakes on a high event within the budget, with the board state sent first and the actual wake time recorded', async () => {
        await service.publish(P1, blocked('r1'));
        await until(() => stub.prompts.length > 0);

        const prompt = stub.text();
        expect(prompt).toContain('kind="run-blocked" priority="high" source="gilde"');
        expect(prompt).toContain(`Run r1 of job ${JOB} ended blocked in acme/api`);
        expect(prompt.indexOf('Board of project')).toBeGreaterThanOrEqual(0);
        expect(prompt.indexOf('Board of project')).toBeLessThan(prompt.indexOf('kind="run-blocked"'));
        expect(prompt).toContain('queued 2');
        expect((await day()).wakesUsed).toBe(1);
        expect((await day()).lastWakeAt).toEqual(clock);
        expect(await new ScoutWakeReader(ds.getRepository(ScoutWakeDay)).lastWakeAt(P1)).toEqual(clock);
        const [record] = await records();
        expect(record).toMatchObject({ source: 'gilde', kind: 'run-blocked', priority: 'high', dedupeKey: 'run-outcome:r1:blocked' });
        expect(record.payload).toEqual({ projectId: P1, repo: 'acme/api', jobId: JOB, runId: 'r1', repoId: REPO, outcome: 'blocked' });
    });

    describe('global budget hard', () => {
        it('sends no wake for a high event, consumes no quota and keeps it pending', async () => {
            globalHard = true;
            await service.publish(P1, blocked('r1'));
            const [record] = await records();
            expect(record).toMatchObject({ kind: 'run-blocked', status: 'pending' });
            expect(record.metadata?.wake).toBe('deferred');
            expect(stub.prompts).toHaveLength(0);
            expect(statusSnapshot).not.toHaveBeenCalled();
            expect(await ds.getRepository(ScoutWakeDay).count()).toBe(0);
        });

        it('sends no daily summary while hard, keeps the backlog, and sends it at the next eligible summary after recovery', async () => {
            globalHard = true;
            await service.publish(P1, blocked('r1'));
            await service.publish(P1, review('fb1'));
            clock = new Date('2030-03-10T06:01:00Z');
            await dispatch();
            expect(await service.allowSummary(P1)).toBe(false);
            expect(stub.prompts).toHaveLength(0);
            expect(await ds.getRepository(ScoutWakeDay).count()).toBe(0); // no summary or wake quota claimed
            expect((await records()).every((r) => r.status === 'pending')).toBe(true);

            globalHard = false; // reset, or the limit was raised
            clock = new Date('2030-03-11T06:05:00Z');
            await dispatch();
            await until(() => stub.prompts.length === 1);
            expect(stub.text()).toContain('<notification-summary pending="2"');
            expect((await day()).wakesUsed).toBe(1);
        });

        it('does not bypass the stop with a catch-up wake when a new high event arrives while still hard', async () => {
            globalHard = true;
            await service.publish(P1, blocked('r1'));
            await service.publish(P1, blocked('r2'));
            clock = new Date('2030-03-10T09:00:00Z');
            await dispatch();
            expect(stub.prompts).toHaveLength(0);
            expect(await records()).toHaveLength(2);
        });

        it('fails closed when the budget cannot be read', async () => {
            vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            globalHard = new Error('usage db down');
            await service.publish(P1, blocked('r1'));
            await service.publish(P1, lesson('l1'));
            clock = new Date('2030-03-10T06:01:00Z');
            expect(await service.allowSummary(P1)).toBe(false);
            expect(stub.prompts).toHaveLength(0);
            expect(await ds.getRepository(ScoutWakeDay).count()).toBe(0);
        });

        it('wakes again once the budget is no longer hard', async () => {
            globalHard = true;
            await service.publish(P1, blocked('r1'));
            globalHard = false;
            await service.publish(P1, blocked('r2'));
            await until(() => stub.prompts.length > 0);
            expect((await day()).wakesUsed).toBe(1);
        });
    });

    it('keeps medium and low events pending without waking and without sending board state', async () => {
        await service.publish(P1, review('fb1'));
        await service.publish(P1, lesson('l1'));
        const stored = await records();
        expect(stored.map((r) => r.kind).sort()).toEqual(['lesson-new', 'review-changes-requested']);
        expect(stored.every((r) => r.status === 'pending' && r.summaryAt && r.summaryAt.toISOString() === '2030-03-10T06:00:00.000Z')).toBe(true);
        expect(stub.prompts).toHaveLength(0);
        expect(statusSnapshot).not.toHaveBeenCalled();
        expect((await ds.getRepository(ScoutWakeDay).find())).toHaveLength(0);
    });

    it('delivers one event once on redelivery, concurrent redelivery and after a restart', async () => {
        await Promise.all([1, 2, 3, 4].map(() => service.publish(P1, lesson('l1'))));
        await service.publish(P1, lesson('l1'));
        expect(await records()).toHaveLength(1);

        await mastra.shutdown?.();
        await boot();
        await service.publish(P1, lesson('l1'));
        expect(await records()).toHaveLength(1);
        expect(await ds.getRepository(ScoutSignalReceipt).count()).toBe(1);
    });

    it('delivers a high event once even after its first record was delivered (receipt, not inbox, is the dedupe)', async () => {
        await service.publish(P1, blocked('r1'));
        await until(() => stub.prompts.length === 1);
        await until(async () => (await records())[0]?.status === 'delivered');
        await service.publish(P1, blocked('r1'));
        expect(await records()).toHaveLength(1);
        expect((await day()).wakesUsed).toBe(1);
    });

    it('never exceeds the daily wake cap with concurrent high events; over-budget events stay pending for the summary', async () => {
        await mastra.shutdown?.();
        await boot({ maxWakes: 2 });
        await Promise.all([1, 2, 3, 4, 5].map((i) => service.publish(P1, blocked(`r${i}`))));
        await until(() => stub.prompts.length >= 1);
        const stored = await records();
        expect(stored).toHaveLength(5);
        expect((await day()).wakesUsed).toBe(2);
        const pending = stored.filter((r) => r.metadata?.wake === 'deferred');
        expect(pending).toHaveLength(3);
        expect(pending.every((r) => r.status === 'pending' && r.summaryAt)).toBe(true);
    });

    it('reserves one summary slot while backlog exists', async () => {
        await mastra.shutdown?.();
        await boot({ maxWakes: 2 });
        await service.publish(P1, review('fb1')); // backlog that will wake
        await service.publish(P1, blocked('r1')); // may use the first slot
        await service.publish(P1, blocked('r2')); // the second is reserved for the summary
        expect((await day()).wakesUsed).toBe(1);
        const kinds = Object.fromEntries((await records()).filter((r) => r.kind === 'run-blocked').map((r) => [r.dedupeKey, r.metadata?.wake]));
        expect(kinds).toEqual({ 'run-outcome:r1:blocked': 'granted', 'run-outcome:r2:blocked': 'deferred' });
    });

    it('sends one native <notification-summary> at the configured UTC hour, never before, and counts it as a wake', async () => {
        await service.publish(P1, lesson('l1'));
        await service.publish(P1, review('fb1'));

        await dispatch(); // 05:00: not due
        expect(stub.prompts).toHaveLength(0);

        clock = new Date('2030-03-10T06:01:00Z');
        const due = await dispatch();
        expect(due.signals.length).toBeGreaterThan(0);
        await until(() => stub.prompts.length > 0);
        expect(stub.text()).toContain('<notification-summary pending="2"');
        expect(stub.text().indexOf('<state>Board of project')).toBeLessThan(stub.text().indexOf('<notification-summary pending'));
        expect((await day()).wakesUsed).toBe(1);
        expect((await day()).summaryClaimedAt).toEqual(clock);
        expect(await new ScoutWakeReader(ds.getRepository(ScoutWakeDay)).lastWakeAt(P1)).toEqual(clock);

        // At most one summary per day: a later event waits for tomorrow, and a second pass sends nothing.
        await service.publish(P1, lesson('l2'));
        const [fresh] = (await records()).filter((r) => r.dedupeKey === 'lesson-new:l2');
        expect(fresh.summaryAt?.toISOString()).toBe('2030-03-11T06:00:00.000Z');
        clock = new Date('2030-03-10T23:00:00Z');
        await dispatch();
        expect(stub.prompts).toHaveLength(1);
    });

    it('persists a summary of low events only without waking, and then does not count it as a wake', async () => {
        await service.publish(P1, lesson('l1'));
        clock = new Date('2030-03-10T06:01:00Z');
        await dispatch();
        await until(async () => (await day()).summaryClaimedAt !== null);
        expect((await day()).wakesUsed).toBe(0);
        expect((await day()).lastWakeAt).toBeNull();
        expect(stub.prompts).toHaveLength(0);
    });

    it('sends no empty summary', async () => {
        clock = new Date('2030-03-10T07:00:00Z');
        await dispatch();
        expect(stub.prompts).toHaveLength(0);
        expect(await ds.getRepository(ScoutWakeDay).count()).toBe(0);
    });

    it('holds the backlog when the cap is already spent, and sends it in the next day\'s summary', async () => {
        await mastra.shutdown?.();
        await boot({ maxWakes: 1 });
        await service.publish(P1, review('fb1')); // backlog: reserves the only slot
        await service.publish(P1, blocked('r1')); // over budget: pending
        expect((await day()).wakesUsed).toBe(0);

        clock = new Date('2030-03-10T06:30:00Z');
        // Exhaust the day's single wake by hand (another process / earlier summary), then try to dispatch.
        await ds.getRepository(ScoutWakeDay).update({ projectId: P1 }, { wakesUsed: 1 });
        await dispatch();
        expect(stub.prompts).toHaveLength(0);
        expect((await records()).every((r) => r.status === 'pending')).toBe(true);

        clock = new Date('2030-03-11T06:05:00Z');
        await dispatch();
        await until(() => stub.prompts.length === 1);
        expect(stub.text()).toContain('<notification-summary pending="2"');
        expect((await day()).wakesUsed).toBe(1);
    });

    it('cannot send two summaries across concurrent dispatchers or a restart in the same day', async () => {
        await service.publish(P1, review('fb1'));
        clock = new Date('2030-03-10T06:01:00Z');
        const [a, b] = await Promise.all([service.allowSummary(P1), service.allowSummary(P1)]);
        expect([a, b]).toEqual([true, true]); // same pass
        expect((await day()).wakesUsed).toBe(1);

        await mastra.shutdown?.();
        await boot();
        clock = new Date('2030-03-10T09:00:00Z'); // a later pass the same day
        expect(await service.allowSummary(P1)).toBe(false);
        expect((await day()).wakesUsed).toBe(1);
    });

    it('sends the board state only when it changed (cacheKey), and counts come from the full-project snapshot', async () => {
        expect((await service.sendBoardState(P1)).sent).toBe(true);
        expect((await service.sendBoardState(P1)).sent).toBe(false);
        statusSnapshot.mockResolvedValue({ counts: { queued: 3, parked: 1 }, parkedIds: [JOB] });
        expect((await service.sendBoardState(P1)).sent).toBe(true);
        expect(statusSnapshot).toHaveBeenCalledWith(P1, 20);
    });

    it('does not claim a wake that could not be handed over: a pre-send failure refunds it and a retry works', async () => {
        const original = service['deps'].threads.ensureThread.bind(service['deps'].threads);
        let calls = 0;
        service['deps'].threads.ensureThread = async (id: string) => {
            calls++;
            if (calls === 2) throw new Error('storage down'); // 1st call: delivery's ensureThread; 2nd: board state
            return original(id);
        };
        await service.publish(P1, blocked('r1')); // board state fails (logged), the wake still goes out
        await until(() => stub.prompts.length === 1);
        expect((await day()).wakesUsed).toBe(1);

        service['deps'].threads.ensureThread = async () => { throw new Error('storage down'); };
        await expect(service.publish(P1, blocked('r2'))).resolves.toBeUndefined();
        expect((await day()).wakesUsed).toBe(1); // nothing was claimed
        expect(await ds.getRepository(ScoutSignalReceipt).findOneBy({ dedupeKey: 'run-outcome:r2:blocked' })).toBeNull();
    });

    it('keeps a claimed wake when sending fails ambiguously, and lets a redelivery try again', async () => {
        const agent = mastra.getAgent('verkenner');
        const spy = vi.spyOn(agent, 'sendNotificationSignal').mockRejectedValueOnce(new Error('connection reset'));
        await expect(service.publish(P1, blocked('r1'))).resolves.toBeUndefined();
        expect((await day()).wakesUsed).toBe(1); // not refunded: the wake may have happened
        expect(await ds.getRepository(ScoutSignalReceipt).count()).toBe(0);
        spy.mockRestore();
        await service.publish(P1, blocked('r1'));
        expect(await records()).toHaveLength(1);
    });

    it('never throws into the caller, whatever fails', async () => {
        const publisher = new ScoutSignalPublisher();
        publisher.register(async () => { throw new Error('boom'); });
        await expect(publisher.publish(P1, lesson('l1'))).resolves.toBeUndefined();
        service['deps'].receipts = { insert: async () => { throw new Error('db down'); } } as never;
        await expect(service.publish(P1, lesson('l2'))).resolves.toBeUndefined();
    });

    it('creates the scheduled native dispatcher (cron) only once something is deferred', async () => {
        const schedules = (await infra.storage.getStore('schedules'))!;
        expect(await schedules.listSchedules()).toHaveLength(0);
        await service.publish(P1, review('fb1'));
        await until(async () => (await schedules.listSchedules()).length > 0);
        const [row] = await schedules.listSchedules();
        expect(row.id).toBe('__mastra_notification_dispatch');
        expect(row.cron).toBe(SCOUT_DISPATCH_CRON);
    });

    it('does not replay history: starting the service sends and schedules nothing', async () => {
        expect(await records()).toHaveLength(0);
        const schedules = (await infra.storage.getStore('schedules'))!;
        expect(await schedules.listSchedules()).toHaveLength(0);
        expect(await ds.getRepository(ScoutSignalReceipt).count()).toBe(0);
    });
});

describe('ScoutSignalPublisher', () => {
    it('is a no-op without a sink (scout off)', async () => {
        const publisher = new ScoutSignalPublisher();
        expect(publisher.active).toBe(false);
        await expect(publisher.publish(P1, lesson('l1'))).resolves.toBeUndefined();
    });
});
