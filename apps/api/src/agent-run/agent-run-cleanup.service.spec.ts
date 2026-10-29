import { AgentRunCleanupService } from './agent-run-cleanup.service.js';
import { runLogDb } from './agent-run.testing.js';
import type { AgentRun } from './agent-run.entity.js';

const DAY = 86_400_000;
const NOW = new Date('2026-10-29T12:00:00Z');

describe('AgentRunCleanupService', () => {
    let db: Awaited<ReturnType<typeof runLogDb>>;
    let service: AgentRunCleanupService;
    beforeEach(async () => {
        db = await runLogDb();
        service = new AgentRunCleanupService(db.runs, db.toolCalls);
    });
    afterEach(async () => { delete process.env.AGENT_LOG_RETENTION_DAYS; await db.ds.destroy(); });

    const run = async (daysAgo: number, over: Partial<AgentRun> = {}) => {
        const r = await db.runs.save(db.runs.create({ agentId: 'gilde', triggerKind: 'chat', startedAt: new Date(NOW.getTime() - daysAgo * DAY), endedAt: new Date(NOW.getTime() - daysAgo * DAY), outcome: 'ok', ...over }));
        await db.toolCalls.save(db.toolCalls.create({ runId: r.id, toolName: 't' }));
        return r;
    };

    it('removes runs older than 90 days by default, with their tool calls, and keeps the rest', async () => {
        const old = await run(91), edge = await run(89), fresh = await run(1);
        expect(await service.cleanup(NOW)).toBe(1);
        expect((await db.runs.find()).map((r) => r.id).sort()).toEqual([edge.id, fresh.id].sort());
        expect(await db.toolCalls.countBy({ runId: old.id })).toBe(0);
        expect(await db.toolCalls.count()).toBe(2);
    });

    it('follows AGENT_LOG_RETENTION_DAYS', async () => {
        process.env.AGENT_LOG_RETENTION_DAYS = '7';
        const gone = await run(8), kept = await run(6);
        await service.cleanup(NOW);
        expect((await db.runs.find()).map((r) => r.id)).toEqual([kept.id]);
        expect(await db.toolCalls.countBy({ runId: gone.id })).toBe(0);
    });

    it('works through more runs than one batch', async () => {
        for (let chunk = 0; chunk < 12; chunk++) {
            await db.runs.insert(Array.from({ length: 100 }, (_, i) => ({ agentId: 'gilde' as const, triggerKind: 'chat' as const, startedAt: new Date(NOW.getTime() - (100 + i % 5) * DAY) })));
        }
        await run(1);
        expect(await service.cleanup(NOW)).toBe(1200);
        expect(await db.runs.count()).toBe(1);
    });

    it('an invalid retention setting is an error the scheduled job logs instead of deleting with a wrong window', async () => {
        process.env.AGENT_LOG_RETENTION_DAYS = '0';
        await run(500);
        await expect(service.cleanup(NOW)).rejects.toThrow('AGENT_LOG_RETENTION_DAYS');
        await expect(service.scheduled()).resolves.toBeUndefined();
        expect(await db.runs.count()).toBe(1);
    });

    it('closes runs that never reported an end, but not recent ones and not coding-agent runs', async () => {
        const stale = await run(0, { startedAt: new Date(NOW.getTime() - 3_600_000), endedAt: null, outcome: null });
        const recent = await run(0, { startedAt: new Date(NOW.getTime() - 60_000), endedAt: null, outcome: null });
        const coding = await run(0, { agentId: 'coding', triggerKind: 'dispatch', startedAt: new Date(NOW.getTime() - 3 * DAY), endedAt: null, outcome: null });
        expect(await service.closeStale(NOW)).toBe(1);
        expect(await db.runs.findOneByOrFail({ id: stale.id })).toMatchObject({ outcome: 'error', reason: 'The run did not report an end' });
        expect((await db.runs.findOneByOrFail({ id: recent.id })).outcome).toBeNull();
        expect((await db.runs.findOneByOrFail({ id: coding.id })).outcome).toBeNull();
    });
});
