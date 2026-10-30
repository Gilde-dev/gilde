import { randomUUID } from 'node:crypto';

import { NotFoundException } from '@nestjs/common';

import { AgentRunService } from './agent-run.service.js';
import { runLogDb } from './agent-run.testing.js';
import type { AgentRun } from './agent-run.entity.js';

const ANN = { id: randomUUID(), name: 'Ann', email: 'ann@example.com', credential: 'jwt' as const };
const BOB = { id: randomUUID(), name: 'Bob', email: 'bob@example.com', credential: 'jwt' as const };
const T0 = new Date('2026-10-01T10:00:00Z').getTime();
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

describe('AgentRunService', () => {
    let db: Awaited<ReturnType<typeof runLogDb>>;
    let service: AgentRunService;
    beforeEach(async () => {
        db = await runLogDb();
        service = new AgentRunService(db.runs, db.toolCalls, db.usage, db.jobRuns, db.executors);
    });
    afterEach(() => db.ds.destroy());

    const run = async (over: Partial<AgentRun>) => db.runs.save(db.runs.create({
        agentId: 'verkenner', triggerKind: 'signal', startedAt: at(0), endedAt: at(1), outcome: 'ok', ...over,
    }));
    const call = (runId: string, over: object = {}) => db.toolCalls.save(db.toolCalls.create({ runId, toolName: 'listJobs', input: '{"q":1}', output: '[1]', durationMs: 5, ...over }));

    it('lists the runs of one agent, newest first, with tool call counts', async () => {
        const p = randomUUID();
        const older = await run({ startedAt: at(0), projectId: p });
        const newer = await run({ startedAt: at(10), projectId: p });
        await run({ agentId: 'verfijner', triggerKind: 'intake_item', startedAt: at(20) });
        await call(newer.id); await call(newer.id);
        const page = await service.list('verkenner', {}, ANN);
        expect(page).toMatchObject({ page: 1, pageSize: 25, total: 2 });
        expect(page.items.map((r) => r.id)).toEqual([newer.id, older.id]);
        expect(page.items.map((r) => r.toolCallCount)).toEqual([2, 0]);
        expect(page.items[0]).toMatchObject({ agentId: 'verkenner', triggerKind: 'signal', projectId: p, outcome: 'ok', metadataOnly: false });
    });

    it('filters by trigger, outcome, project and period', async () => {
        const p1 = randomUUID(), p2 = randomUUID();
        const a = await run({ triggerKind: 'signal', outcome: 'ok', projectId: p1, startedAt: at(0) });
        const b = await run({ triggerKind: 'schedule', outcome: 'error', projectId: p1, startedAt: at(60) });
        const c = await run({ triggerKind: 'signal', outcome: 'skipped', projectId: p2, startedAt: at(120) });
        const ids = async (q: object) => (await service.list('verkenner', q, ANN)).items.map((r) => r.id).sort();
        expect(await ids({ trigger: 'signal' })).toEqual([a.id, c.id].sort());
        expect(await ids({ outcome: 'error' })).toEqual([b.id]);
        expect(await ids({ projectId: p1 })).toEqual([a.id, b.id].sort());
        expect(await ids({ from: at(30), to: at(90) })).toEqual([b.id]);
        expect(await ids({ from: at(60) })).toEqual([b.id, c.id].sort());
        expect(await ids({ to: at(60) })).toEqual([a.id]); // the end of the period is exclusive
        expect(await ids({ trigger: 'signal', outcome: 'skipped', projectId: p2, from: at(100), to: at(130) })).toEqual([c.id]);
        expect(await ids({ trigger: 'chat' })).toEqual([]);
    });

    it('paginates with a stable order and reports the total', async () => {
        const created = [];
        for (let i = 0; i < 7; i++) created.push(await run({ startedAt: at(i) }));
        const newestFirst = created.map((r) => r.id).reverse();
        const first = await service.list('verkenner', { pageSize: 3 }, ANN);
        const second = await service.list('verkenner', { pageSize: 3, page: 2 }, ANN);
        const third = await service.list('verkenner', { pageSize: 3, page: 3 }, ANN);
        const beyond = await service.list('verkenner', { pageSize: 3, page: 4 }, ANN);
        expect([...first.items, ...second.items, ...third.items].map((r) => r.id)).toEqual(newestFirst);
        expect([first.total, second.total, third.total, beyond.total]).toEqual([7, 7, 7, 7]);
        expect(third.items).toHaveLength(1);
        expect(beyond.items).toEqual([]);
    });

    it('a user sees the content of their own co-pilot runs, in full', async () => {
        const mine = await run({ agentId: 'gilde', triggerKind: 'chat', actorUserId: ANN.id, triggerRefType: 'thread', triggerRefId: 'thread-1', reason: 'because', model: 'openai/m', costUsd: 0.01 });
        await call(mine.id, { toolName: 'getJob', input: '{"jobId":"j1"}', output: '{"task":"secret plan"}' });
        const [item] = (await service.list('gilde', {}, ANN)).items;
        expect(item).toMatchObject({ metadataOnly: false, triggerRefId: 'thread-1', reason: 'because', toolCallCount: 1 });
        const detail = await service.get(mine.id, ANN);
        expect(detail.toolCalls).toHaveLength(1);
        expect(detail.toolCalls[0]).toMatchObject({ toolName: 'getJob', input: '{"jobId":"j1"}', output: '{"task":"secret plan"}' });
    });

    it("another user's co-pilot run is metadata only: time, tool count, outcome and cost, never content", async () => {
        const theirs = await run({ agentId: 'gilde', triggerKind: 'chat', actorUserId: BOB.id, triggerRefType: 'thread', triggerRefId: 'bobs-thread', reason: 'Bob asked about X', model: 'openai/m', costUsd: 0.5, inputTokens: 10, outputTokens: 5, startedAt: at(3) });
        await call(theirs.id, { toolName: 'getJob', input: '{"jobId":"bobs-job"}', output: '{"task":"bobs private task"}' });
        await call(theirs.id, { toolName: 'listJobs' });

        const page = await service.list('gilde', {}, ANN);
        const [item] = page.items;
        expect(item).toMatchObject({ metadataOnly: true, toolCallCount: 2, outcome: 'ok', costUsd: 0.5, startedAt: at(3).toISOString(), reason: null, triggerRefType: null, triggerRefId: null });
        expect(JSON.stringify(page)).not.toContain('bobs-thread');
        expect(JSON.stringify(page)).not.toContain('Bob asked');

        const detail = await service.get(theirs.id, ANN);
        expect(detail).toMatchObject({ metadataOnly: true, toolCallCount: 2, toolCalls: [] });
        expect(JSON.stringify(detail)).not.toContain('bobs');
        // Also without any authenticated user (AUTH_ENABLED=false): nobody owns it.
        expect((await service.get(theirs.id, null)).toolCalls).toEqual([]);
        expect((await service.list('gilde', {}, null)).items[0].metadataOnly).toBe(true);
    });

    it('the privacy rule is for the co-pilot: runs of unattended agents and MCP calls show their tool calls to everyone', async () => {
        const scout = await run({ agentId: 'verkenner', actorUserId: BOB.id });
        await call(scout.id, { toolName: 'listRepos' });
        const mcp = await run({ agentId: 'mcp', triggerKind: 'mcp_call', actorUserId: BOB.id });
        await call(mcp.id, { toolName: 'getJob' });
        expect((await service.get(scout.id, ANN)).toolCalls).toHaveLength(1);
        expect((await service.get(mcp.id, ANN)).toolCalls).toHaveLength(1);
    });

    it('fills tokens and cost of a coding-agent run from the usage attributed to its job run', async () => {
        const jobRunId = randomUUID();
        const coding = await run({ agentId: 'coding', triggerKind: 'dispatch', linkedTable: 'job_runs', linkedId: jobRunId });
        const usage = (over: object) => db.usage.save(db.usage.create({ sessionId: 's', model: 'claude', eventKey: randomUUID(), eventAt: at(2), runId: jobRunId, inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheCreationTokens: 5, costUsd: 0.2, ...over }));
        await usage({}); await usage({ costUsd: 0.1 });
        const [item] = (await service.list('coding', {}, ANN)).items;
        expect(item).toMatchObject({ id: coding.id, inputTokens: 310, outputTokens: 20 });
        expect(item.costUsd).toBeCloseTo(0.3);
    });

    it('returns 404 for an unknown run', async () => {
        await expect(service.get(randomUUID(), ANN)).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('coding agents', () => {
        const jobRun = (executorId: string | null) => db.jobRuns.save(db.jobRuns.create({ jobId: randomUUID(), projectId: randomUUID(), repoId: randomUUID(), attempt: 1, executorId } as never));
        const owner = () => db.users.save(db.users.create({ email: `${randomUUID()}@example.com`, name: 'Owner', password: 'x' } as never));

        it('shows the executor of a job run and filters by it', async () => {
            const user = await owner();
            const e1 = await db.executors.save(db.executors.create({ ownerId: user.id, name: 'Alpha', fireUrl: 'https://example.com/fire', repoIds: [] } as never));
            const e2 = await db.executors.save(db.executors.create({ ownerId: user.id, name: 'Beta', fireUrl: 'https://example.com/fire', repoIds: [] } as never));
            const r1 = await jobRun(e1.id); const r2 = await jobRun(e2.id); const r3 = await jobRun(null);
            const a = await run({ agentId: 'coding', triggerKind: 'dispatch', linkedTable: 'job_runs', linkedId: r1.id, startedAt: at(0) });
            await run({ agentId: 'coding', triggerKind: 'dispatch', linkedTable: 'job_runs', linkedId: r2.id, startedAt: at(1) });
            await run({ agentId: 'coding', triggerKind: 'dispatch', linkedTable: 'job_runs', linkedId: r3.id, startedAt: at(2) });
            await run({ agentId: 'verkenner', startedAt: at(3) });

            const all = await service.list('coding', {}, ANN);
            expect(all.items.map((i) => i.executor?.name ?? null)).toEqual([null, 'Beta', 'Alpha']);
            const filtered = await service.list('coding', { executorId: e1.id }, ANN);
            expect(filtered.total).toBe(1);
            expect(filtered.items[0]).toMatchObject({ id: a.id, executor: { id: e1.id, name: 'Alpha' } });
            expect((await service.list('verkenner', {}, ANN)).items[0].executor).toBeNull();
        });
    });
});
