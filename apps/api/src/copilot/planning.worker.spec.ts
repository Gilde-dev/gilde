import { randomUUID } from 'node:crypto';

import { runLogDb } from '../agent-run/agent-run.testing.js';
import type { PlanSetup } from './copilot.mastra.js';
import { PlanningWorker } from './planning.worker.js';
import { planConfig } from './werkmeester.config.js';

const BOT = { id: 'bot', name: 'Werkmeester', email: 'werkmeester@example.com' };
const config = planConfig({ PLAN_ENABLED: 'true', PLAN_USER_EMAIL: BOT.email, PLAN_MODEL: 'openai/m', OPENAI_API_KEY: 'k', PLAN_DAILY_LIMIT: '2' });
if (!config.enabled) throw new Error('test setup');

const run = (over: Record<string, unknown> = {}) => ({ id: randomUUID(), specId: randomUUID(), projectId: 'p1', version: 1, approvalId: randomUUID(), attempts: 0, ...over });

describe('PlanningWorker', () => {
    const planning = {
        recoverStale: vi.fn(), nextPerProject: vi.fn(), runsToday: vi.fn(), begin: vi.fn(), pinnedFeature: vi.fn(),
        planned: vi.fn(), skipped: vi.fn(), failed: vi.fn(), specTitle: vi.fn(),
    };
    const werkmeester = { bind: vi.fn(), plan: vi.fn() };
    const budget = { status: vi.fn() };
    const notifications = { specPlanned: vi.fn(), specPlanFailed: vi.fn() };
    const worker = (runLog?: object) => new PlanningWorker({ config, user: BOT } as unknown as PlanSetup, werkmeester as never, planning as never, budget as never, notifications as never, runLog as never);

    beforeEach(() => {
        vi.resetAllMocks();
        planning.recoverStale.mockResolvedValue(0);
        planning.runsToday.mockResolvedValue(0);
        planning.begin.mockImplementation(async (r: { attempts: number }) => ({ ...r, attempts: r.attempts + 1 }));
        planning.pinnedFeature.mockResolvedValue(null);
        planning.failed.mockResolvedValue('queued');
        planning.planned.mockResolvedValue(true);
        planning.specTitle.mockResolvedValue('Dark mode');
        werkmeester.bind.mockImplementation((t: object) => ({ ...t, issued: true }));
        budget.status.mockResolvedValue({ hardBlocked: false });
    });

    describe('run log', () => {
        let db: Awaited<ReturnType<typeof runLogDb>>;
        beforeEach(async () => { db = await runLogDb(); });
        afterEach(() => db.ds.destroy());

        it('records a planning run as a spec_version run linked to its planning run, per outcome', async () => {
            const planned = run(), skipped = run({ projectId: 'p2' }), failed = run({ projectId: 'p3' }), pinned = run({ projectId: 'p4' });
            planning.nextPerProject.mockResolvedValue([planned, skipped, failed, pinned]);
            planning.pinnedFeature.mockImplementation(async (specId: string) => (specId === pinned.specId ? { id: 'f9', title: 'Dark mode' } : null));
            werkmeester.plan.mockImplementation(async (binding: { projectId: string }) => {
                if (binding.projectId === 'p2') return { outcome: 'skipped', reason: 'spec archived' };
                if (binding.projectId === 'p3') return { outcome: 'failed', reason: 'no valid plan' };
                return { outcome: 'planned', featureId: 'f1' };
            });
            await worker(db.recorder).tick();
            await db.recorder.flush();

            const byRun = async (r: { id: string }) => db.runs.findOneByOrFail({ linkedId: r.id });
            expect(await byRun(planned)).toMatchObject({ agentId: 'werkmeester', triggerKind: 'spec_version', triggerRefType: 'spec', triggerRefId: planned.specId, actorUserId: BOT.id, projectId: 'p1', linkedTable: 'spec_planning_runs', outcome: 'ok', model: 'openai/m' });
            expect(await byRun(skipped)).toMatchObject({ outcome: 'skipped', reason: 'spec archived' });
            expect(await byRun(failed)).toMatchObject({ outcome: 'error', reason: 'no valid plan' });
            expect(await byRun(pinned)).toMatchObject({ outcome: 'skipped' });
            expect(werkmeester.plan).toHaveBeenCalledTimes(3); // the pinned version never reaches the agent
            expect(werkmeester.plan.mock.calls[0][1]).toBeDefined(); // the run handle goes to the agent run
        });

        it('records an error when planning throws, and a failing recorder does not fail the run', async () => {
            const r = run();
            planning.nextPerProject.mockResolvedValue([r]);
            werkmeester.plan.mockRejectedValue(new Error('model down'));
            await worker(db.recorder).tick();
            await db.recorder.flush();
            expect(await db.runs.findOneByOrFail({ linkedId: r.id })).toMatchObject({ outcome: 'error', reason: 'model down' });

            werkmeester.plan.mockResolvedValue({ outcome: 'planned', featureId: 'f1' });
            const broken = { begin: () => { throw new Error('recorder down'); } };
            expect(await worker(broken).tick()).toEqual([r.id]);
            expect(planning.planned).toHaveBeenCalledWith(r.id, 'f1');
        });
    });

    it('plans the next run of each project and records the feature', async () => {
        const a = run();
        const b = run({ projectId: 'p2' });
        planning.nextPerProject.mockResolvedValue([a, b]);
        werkmeester.plan.mockResolvedValue({ outcome: 'planned', featureId: 'f1' });
        expect(await worker().tick()).toEqual([a.id, b.id]);
        expect(werkmeester.bind).toHaveBeenCalledWith({ projectId: 'p1', specId: a.specId, version: 1, approvalId: a.approvalId }, 1);
        expect(planning.planned).toHaveBeenCalledWith(a.id, 'f1');
        expect(planning.planned).toHaveBeenCalledWith(b.id, 'f1');
    });

    it('notifies spec.planned once the run is stored as planned, and not when another worker finished it', async () => {
        const r = run();
        planning.nextPerProject.mockResolvedValue([r]);
        werkmeester.plan.mockResolvedValue({ outcome: 'planned', featureId: 'f1' });
        await worker().tick();
        expect(notifications.specPlanned).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: r.id, projectId: 'p1' }), 'f1');
        notifications.specPlanned.mockClear();
        planning.planned.mockResolvedValue(false);
        await worker().tick();
        expect(notifications.specPlanned).not.toHaveBeenCalled();
    });

    it('notifies spec.plan_failed only for the final failure, not for a retry', async () => {
        const r = run();
        planning.nextPerProject.mockResolvedValue([r]);
        werkmeester.plan.mockResolvedValue({ outcome: 'failed', reason: 'no plan' });
        await worker().tick();
        expect(notifications.specPlanFailed).not.toHaveBeenCalled();
        planning.failed.mockResolvedValue('failed');
        await worker().tick();
        expect(notifications.specPlanFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: r.id }), 'Dark mode', 1, 'no plan');
    });

    it('stays within the daily limit', async () => {
        planning.nextPerProject.mockResolvedValue([run()]);
        planning.runsToday.mockResolvedValue(2);
        expect(await worker().tick()).toEqual([]);
        expect(planning.begin).not.toHaveBeenCalled();
        expect(werkmeester.plan).not.toHaveBeenCalled();
    });

    it('does not plan while the budget is hard, nor when it cannot be read', async () => {
        planning.nextPerProject.mockResolvedValue([run()]);
        budget.status.mockResolvedValue({ hardBlocked: true });
        expect(await worker().tick()).toEqual([]);
        budget.status.mockRejectedValue(new Error('db down'));
        expect(await worker().tick()).toEqual([]);
        expect(planning.begin).not.toHaveBeenCalled();
    });

    it('skips a version with a pinned feature without calling the agent', async () => {
        const r = run();
        planning.nextPerProject.mockResolvedValue([r]);
        planning.pinnedFeature.mockResolvedValue({ id: 'f9', title: 'Existing' });
        await worker().tick();
        expect(werkmeester.plan).not.toHaveBeenCalled();
        expect(planning.skipped).toHaveBeenCalledWith(r.id, expect.stringContaining('Existing'), 'f9');
    });

    it('records skipped and failed outcomes, and an agent that throws as a failed attempt', async () => {
        const r = run();
        planning.nextPerProject.mockResolvedValue([r]);
        werkmeester.plan.mockResolvedValueOnce({ outcome: 'skipped', reason: 'archived' });
        await worker().tick();
        expect(planning.skipped).toHaveBeenCalledWith(r.id, 'archived');
        werkmeester.plan.mockResolvedValueOnce({ outcome: 'failed', reason: 'no plan' });
        await worker().tick();
        expect(planning.failed).toHaveBeenCalledWith(r.id, 'no plan');
        werkmeester.plan.mockRejectedValueOnce(new Error('boom'));
        await worker().tick();
        expect(planning.failed).toHaveBeenCalledWith(r.id, 'boom');
    });

    it('moves on when another worker claimed the run, and ignores an overlapping tick', async () => {
        planning.nextPerProject.mockResolvedValue([run()]);
        planning.begin.mockResolvedValue(null);
        const w = worker();
        expect(await w.tick()).toEqual([]);
        expect(werkmeester.plan).not.toHaveBeenCalled();

        planning.begin.mockImplementation(async (r: object) => r);
        let release!: () => void;
        werkmeester.plan.mockReturnValue(new Promise((resolve) => { release = () => resolve({ outcome: 'planned', featureId: 'f' }); }));
        const first = w.tick();
        await vi.waitFor(() => expect(werkmeester.plan).toHaveBeenCalled());
        expect(await w.tick()).toEqual([]);
        release();
        expect(await first).toHaveLength(1);
    });

    describe('reads its setup on every tick, without a restart', () => {
        it('does nothing while the setup source says the Werkmeester is not on, and starts when it becomes on', async () => {
            const a = run();
            planning.nextPerProject.mockResolvedValue([a]);
            werkmeester.plan.mockResolvedValue({ outcome: 'planned', featureId: 'f1' });
            let current: PlanSetup | null = null;
            const live = new PlanningWorker(async () => current, werkmeester as never, planning as never, budget as never, notifications as never);
            expect(await live.tick()).toEqual([]);
            expect(planning.nextPerProject).not.toHaveBeenCalled();
            current = { config, user: BOT } as unknown as PlanSetup; // the bot user was created / marked / the agent switched on
            expect(await live.tick()).toEqual([a.id]);
            current = null; // switched off again
            planning.nextPerProject.mockClear();
            expect(await live.tick()).toEqual([]);
            expect(planning.nextPerProject).not.toHaveBeenCalled();
        });

        it('applies a changed daily limit on the next tick', async () => {
            planning.nextPerProject.mockResolvedValue([run()]);
            planning.runsToday.mockResolvedValue(2);
            werkmeester.plan.mockResolvedValue({ outcome: 'planned', featureId: 'f1' });
            let limit = 2;
            const live = new PlanningWorker(async () => ({ config: { ...config, dailyLimit: limit }, user: BOT }) as unknown as PlanSetup, werkmeester as never, planning as never, budget as never, notifications as never);
            expect(await live.tick()).toEqual([]);
            limit = 3;
            expect(await live.tick()).toHaveLength(1);
        });
    });
});
