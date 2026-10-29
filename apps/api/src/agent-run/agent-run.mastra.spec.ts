import { createTool } from '@mastra/core/tools';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';

import { copilotDefaultOptions } from '../copilot/copilot.mastra.js';
import { COPILOT_PROJECT_KEY, COPILOT_USER_KEY } from '../copilot/copilot.context.js';
import { issueScoutBinding, SCOUT_BINDING_KEY } from '../copilot/verkenner.context.js';

import { attachRun, ensureRun, recordTools, runLogProcessor, runOf } from './agent-run.mastra.js';
import { runLogDb } from './agent-run.testing.js';

describe('recordTools', () => {
    let db: Awaited<ReturnType<typeof runLogDb>>;
    beforeEach(async () => { db = await runLogDb(); });
    afterEach(() => db.ds.destroy());

    const tools = (fail = false) => ({
        echo: createTool({ id: 'echo', description: 'e', inputSchema: z.object({ text: z.string() }), execute: async ({ text }) => ({ said: text }) }),
        boom: createTool({ id: 'boom', description: 'b', inputSchema: z.object({}), execute: async () => { if (fail) throw new Error('the tool failed'); return 'fine'; } }),
    });
    const contextWith = (run?: unknown) => {
        const requestContext = new RequestContext();
        if (run) attachRun(requestContext, run as never);
        return { requestContext } as never;
    };

    it('records name, input, output and duration, and returns the result untouched', async () => {
        const run = db.recorder.begin({ agentId: 'gilde', triggerKind: 'chat' });
        const wrapped = recordTools(tools());
        await expect(wrapped.echo.execute!({ text: 'hi' }, contextWith(run))).resolves.toEqual({ said: 'hi' });
        await run.settled();
        const [call] = await db.toolCalls.find({ where: { runId: run.id } });
        expect(call).toMatchObject({ toolName: 'echo', input: '{"text":"hi"}', output: '{"said":"hi"}', error: null });
        expect(call.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('records a failing tool and rethrows the same error', async () => {
        const run = db.recorder.begin({ agentId: 'gilde', triggerKind: 'chat' });
        const error = await recordTools(tools(true)).boom.execute!({}, contextWith(run)).catch((e: unknown) => e);
        expect((error as Error).message).toBe('the tool failed');
        await run.settled();
        expect(await db.toolCalls.findOneByOrFail({ runId: run.id })).toMatchObject({ toolName: 'boom', error: 'the tool failed', output: null });
    });

    it('does not change the original tools, keeps their shape and records nothing without a run', async () => {
        const original = tools();
        const execute = original.echo.execute;
        const wrapped = recordTools(original);
        expect(original.echo.execute).toBe(execute);
        expect(wrapped.echo).not.toBe(original.echo);
        expect(wrapped.echo.id).toBe('echo');
        expect(wrapped.echo.description).toBe('e');
        expect(wrapped.echo.inputSchema).toBe(original.echo.inputSchema);
        await expect(wrapped.echo.execute!({ text: 'x' }, contextWith())).resolves.toEqual({ said: 'x' });
        expect(await db.toolCalls.count()).toBe(0);
    });

    it('passes tools without execute through', () => {
        const passive = { id: 'p' };
        expect(recordTools({ passive }).passive).toBe(passive);
    });

    it('a recorder that throws does not change the result or the error of the tool', async () => {
        const broken = { toolCall: () => { throw new Error('recorder down'); } };
        await expect(recordTools(tools()).echo.execute!({ text: 'ok' }, contextWith(broken))).resolves.toEqual({ said: 'ok' });
        await expect(recordTools(tools(true)).boom.execute!({}, contextWith(broken))).rejects.toThrow('the tool failed');
    });
});

describe('the run log of Mastra runs, per trigger kind', () => {
    let db: Awaited<ReturnType<typeof runLogDb>>;
    beforeEach(async () => { db = await runLogDb(); });
    afterEach(() => db.ds.destroy());

    /** What Mastra hands the output processor at the end of a generation. */
    const finishWith = (requestContext: RequestContext) => {
        const messages = [{ role: 'assistant' }];
        const processor = runLogProcessor('openai/m') as unknown as { processOutputResult(args: object): unknown };
        expect(processor.processOutputResult({ messages, requestContext, result: { usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10 } } })).toBe(messages);
    };

    it('a co-pilot request is a chat run of the user, in the selected project, with its thread', async () => {
        const rc = new RequestContext();
        const user = randomId();
        const project = randomId();
        rc.set(COPILOT_USER_KEY, { id: user });
        rc.set(COPILOT_PROJECT_KEY, project);
        rc.set('threadId', 'thread-9');
        const options = copilotDefaultOptions(5, { warn: vi.fn(), log: vi.fn() }, undefined, 'gilde', { log: db.recorder, model: 'openai/m' });
        options.prepareStep({ stepNumber: 0, requestContext: rc });
        options.prepareStep({ stepNumber: 1, requestContext: rc }); // the same run
        const run = runOf(rc)!;
        finishWith(rc);
        await db.recorder.flush();
        const rows = await db.runs.find();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: run.id, agentId: 'gilde', triggerKind: 'chat', actorUserId: user, projectId: project, triggerRefType: 'thread', triggerRefId: 'thread-9', outcome: 'ok', model: 'openai/m', inputTokens: 100, outputTokens: 20 });
        expect(rows[0].endedAt).not.toBeNull();
    });

    it('a scout wake is a signal run for the bound project and the bot user', async () => {
        const rc = new RequestContext();
        const bot = randomId(), project = randomId();
        rc.set(SCOUT_BINDING_KEY, issueScoutBinding(bot, project));
        rc.set(COPILOT_USER_KEY, { id: bot });
        const options = copilotDefaultOptions(5, { warn: vi.fn(), log: vi.fn() }, undefined, 'verkenner', { log: db.recorder, model: 'openai/m' });
        options.prepareStep({ stepNumber: 0, requestContext: rc });
        finishWith(rc);
        await db.recorder.flush();
        expect(await db.runs.findOneByOrFail({ agentId: 'verkenner' })).toMatchObject({ triggerKind: 'signal', actorUserId: bot, projectId: project, triggerRefType: 'project', triggerRefId: project, outcome: 'ok' });
    });

    it('a run its worker owns is not started again, and its finish hook only adds tokens', async () => {
        const rc = new RequestContext();
        const owned = db.recorder.begin({ agentId: 'verfijner', triggerKind: 'intake_item', managed: true });
        attachRun(rc, owned);
        expect(ensureRun(rc, db.recorder, () => ({ agentId: 'verfijner', triggerKind: 'schedule' }))).toBe(owned);
        finishWith(rc);
        await owned.settled();
        expect(await db.runs.count()).toBe(1);
        const row = await db.runs.findOneByOrFail({ id: owned.id });
        expect(row).toMatchObject({ outcome: null, inputTokens: 100 });
    });

    it('a recorder that throws on begin does not break the step', () => {
        const rc = new RequestContext();
        const options = copilotDefaultOptions(5, { warn: vi.fn(), log: vi.fn() }, undefined, 'gilde', { log: { begin: () => { throw new Error('nope'); } }, model: 'm' });
        expect(() => options.prepareStep({ stepNumber: 0, requestContext: rc })).not.toThrow();
        expect(() => finishWith(rc)).not.toThrow();
    });
});

const randomId = () => crypto.randomUUID();
