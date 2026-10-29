import { randomUUID } from 'node:crypto';

import { AgentRunRecorder } from './agent-run.recorder.js';
import { runLogDb } from './agent-run.testing.js';

describe('AgentRunRecorder', () => {
    let db: Awaited<ReturnType<typeof runLogDb>>;
    beforeEach(async () => { db = await runLogDb(); });
    afterEach(async () => { delete process.env.AGENT_LOG_MAX_CHARS; delete process.env.LLM_PRICES; await db.ds.destroy(); });

    it('records a run with its tool calls, timing, tokens and cost', async () => {
        process.env.LLM_PRICES = JSON.stringify({ 'openai/m': { input: 1, output: 2 } });
        const actor = randomUUID(), project = randomUUID();
        const run = db.recorder.begin({ agentId: 'gilde', triggerKind: 'chat', triggerRefType: 'thread', triggerRefId: 't-1', actorUserId: actor, projectId: project, model: 'openai/m' });
        run.toolCall({ name: 'listJobs', input: { status: 'queued' }, output: [{ id: 1 }], durationMs: 12.4 });
        run.toolCall({ name: 'getJob', input: { id: 'x' }, error: new Error('not found') });
        run.end({ outcome: 'ok', model: 'openai/m', inputTokens: 1000, outputTokens: 500 });
        await db.recorder.flush();

        const row = await db.runs.findOneByOrFail({ id: run.id });
        expect(row).toMatchObject({ agentId: 'gilde', triggerKind: 'chat', triggerRefType: 'thread', triggerRefId: 't-1', actorUserId: actor, projectId: project, outcome: 'ok', model: 'openai/m', inputTokens: 1000, outputTokens: 500 });
        expect(row.endedAt).toBeInstanceOf(Date);
        expect(row.costUsd).toBeCloseTo(0.002);
        const calls = await db.toolCalls.find({ where: { runId: run.id }, order: { createdAt: 'ASC' } });
        expect(calls.map((c) => c.toolName).sort()).toEqual(['getJob', 'listJobs']);
        const list = calls.find((c) => c.toolName === 'listJobs')!;
        expect(list).toMatchObject({ input: '{"status":"queued"}', output: '[{"id":1}]', durationMs: 12, error: null });
        expect(calls.find((c) => c.toolName === 'getJob')).toMatchObject({ error: 'not found', output: null });
    });

    it('leaves the cost empty when the model has no price', async () => {
        const run = db.recorder.begin({ agentId: 'gilde', triggerKind: 'chat' });
        run.end({ outcome: 'ok', model: 'openai/unpriced', inputTokens: 5, outputTokens: 5 });
        await run.settled();
        expect(await db.runs.findOneByOrFail({ id: run.id })).toMatchObject({ inputTokens: 5, costUsd: null });
    });

    it('caps tool inputs and outputs at AGENT_LOG_MAX_CHARS (default 2000)', async () => {
        const run = db.recorder.begin({ agentId: 'gilde', triggerKind: 'chat' });
        run.toolCall({ name: 'big', input: 'i'.repeat(5000), output: 'o'.repeat(5000) });
        process.env.AGENT_LOG_MAX_CHARS = '300';
        run.toolCall({ name: 'small', input: 'i'.repeat(5000), output: 'o'.repeat(5000) });
        await run.settled();
        const calls = await db.toolCalls.find({ where: { runId: run.id } });
        const big = calls.find((c) => c.toolName === 'big')!, small = calls.find((c) => c.toolName === 'small')!;
        expect(big.input!.startsWith('i'.repeat(2000))).toBe(true);
        expect(big.input!.length).toBeLessThan(2100);
        expect(big.output!.length).toBeLessThan(2100);
        expect(small.input!.length).toBeLessThan(400);
        expect(small.input).toContain('truncated');
    });

    it('uses the default cap and still records when AGENT_LOG_MAX_CHARS is invalid', async () => {
        process.env.AGENT_LOG_MAX_CHARS = 'lots';
        const run = db.recorder.begin({ agentId: 'gilde', triggerKind: 'chat' });
        run.toolCall({ name: 't', input: 'i'.repeat(5000) });
        await run.settled();
        const [call] = await db.toolCalls.find({ where: { runId: run.id } });
        expect(call.input!.length).toBeLessThan(2100);
    });

    it('never stores a secret, in tool inputs, outputs, errors or reasons', async () => {
        const secrets = ['gk_ab12cd34_0123456789abcdef', 'sk-proj-abcdefghijklmnop1234', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'github_pat_11ABCDEFG0abcdefghijklmnop', 'xoxb-1234567890-abcdefghij', 'Bearer abcdefghijklmnop.qrstu'];
        process.env.JWT_SECRET = 'a-configured-secret-of-32-characters!';
        try {
            const run = db.recorder.begin({ agentId: 'mcp', triggerKind: 'mcp_call' });
            run.toolCall({ name: 'readRepoFile', input: { path: '.env', note: secrets.join(' ') }, output: `leaked ${secrets.join(' | ')} and ${process.env.JWT_SECRET}`, error: new Error(`failed with ${secrets[0]}`) });
            run.end({ outcome: 'error', reason: `boom ${secrets[2]} ${process.env.JWT_SECRET}` });
            await run.settled();
            const dump = JSON.stringify([await db.runs.find(), await db.toolCalls.find()]);
            for (const secret of [...secrets, process.env.JWT_SECRET]) expect(dump).not.toContain(secret);
            expect(dump).toContain('[redacted]');
        } finally {
            delete process.env.JWT_SECRET;
        }
    });

    it('a later end only adds the fields it carries (the worker overrides the outcome of the finish hook)', async () => {
        const run = db.recorder.begin({ agentId: 'verfijner', triggerKind: 'intake_item', managed: true });
        run.end({ model: 'openai/m', inputTokens: 10, outputTokens: 4 });
        run.end({ outcome: 'error', reason: 'The agent finished without saving a spec' });
        await run.settled();
        const row = await db.runs.findOneByOrFail({ id: run.id });
        expect(row).toMatchObject({ outcome: 'error', reason: 'The agent finished without saving a spec', inputTokens: 10, outputTokens: 4 });
        expect(row.endedAt).not.toBeNull();
    });

    it('ends the open run linked to a per-agent record', async () => {
        const jobRun = randomUUID();
        const run = db.recorder.begin({ agentId: 'coding', triggerKind: 'dispatch', linkedTable: 'job_runs', linkedId: jobRun, managed: true });
        await run.settled();
        await db.recorder.endLinked('job_runs', jobRun, { outcome: 'refused', reason: 'blocked: premise is wrong' });
        expect(await db.runs.findOneByOrFail({ id: run.id })).toMatchObject({ outcome: 'refused', reason: 'blocked: premise is wrong' });
        // Nothing open any more: a second end changes nothing, and an unknown link is ignored.
        await db.recorder.endLinked('job_runs', jobRun, { outcome: 'ok' });
        await db.recorder.endLinked('job_runs', randomUUID(), { outcome: 'ok' });
        expect((await db.runs.findOneByOrFail({ id: run.id })).outcome).toBe('refused');
    });

    describe('recording never fails or slows the recorded run', () => {
        it('swallows failing writes and returns at once', async () => {
            const broken = new AgentRunRecorder(
                { create: (v: object) => v, insert: () => Promise.reject(new Error('db down')), update: () => Promise.reject(new Error('db down')), findOne: () => Promise.reject(new Error('db down')) } as never,
                { create: (v: object) => v, insert: () => Promise.reject(new Error('db down')) } as never,
            );
            const run = broken.begin({ agentId: 'gilde', triggerKind: 'chat' });
            expect(() => { run.toolCall({ name: 't', input: 1, output: 2 }); run.end({ outcome: 'ok' }); }).not.toThrow();
            await expect(run.settled()).resolves.toBeUndefined();
            await expect(broken.flush()).resolves.toBeUndefined();
            await expect(broken.endLinked('job_runs', 'x', { outcome: 'error' })).resolves.toBeUndefined();
        });

        it('does not wait for a slow database', async () => {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            const slow = new AgentRunRecorder(
                { create: (v: object) => v, insert: () => gate, update: () => gate } as never,
                { create: (v: object) => v, insert: () => gate } as never,
            );
            const started = Date.now();
            const run = slow.begin({ agentId: 'gilde', triggerKind: 'chat' });
            run.toolCall({ name: 't' });
            run.end({ outcome: 'ok' });
            expect(Date.now() - started).toBeLessThan(50);
            release();
            await slow.flush();
        });

        it('returns a no-op handle when the record cannot even be built', () => {
            const broken = new AgentRunRecorder({ create: () => { throw new Error('boom'); } } as never, {} as never);
            const run = broken.begin({ agentId: 'gilde', triggerKind: 'chat', managed: true });
            expect(run.managed).toBe(true);
            expect(() => { run.toolCall({ name: 't' }); run.end({ outcome: 'ok' }); }).not.toThrow();
        });

        it('keeps recording the next tool calls after one failed to serialize', async () => {
            const run = db.recorder.begin({ agentId: 'gilde', triggerKind: 'chat' });
            const cyclic: Record<string, unknown> = {};
            cyclic.self = cyclic;
            run.toolCall({ name: 'odd', input: cyclic, output: 10n });
            run.toolCall({ name: 'fine', input: 'x' });
            await run.settled();
            expect((await db.toolCalls.find({ where: { runId: run.id } })).map((c) => c.toolName).sort()).toEqual(['fine', 'odd']);
        });
    });

    it('records a finished run in one go', async () => {
        const run = db.recorder.complete({ agentId: 'verkenner', triggerKind: 'chat' }, { outcome: 'refused', reason: 'The agent cannot be used through the API' });
        await run.settled();
        expect(await db.runs.findOneByOrFail({ id: run.id })).toMatchObject({ agentId: 'verkenner', outcome: 'refused' });
    });
});
