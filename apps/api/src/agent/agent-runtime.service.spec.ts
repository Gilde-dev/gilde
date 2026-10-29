import { describe, expect, it, vi } from 'vitest';

import { AgentRuntimeService } from './agent-runtime.service.js';
import type { AgentSettings } from './agent-settings.entity.js';
import { defaultSettings } from './agent-settings.js';
import type { AgentId } from './agent-ids.js';

const BOT = { id: '11111111-1111-4111-8111-111111111111', name: 'Verkenner', email: 'verkenner@example.com', isBot: true };

function setup(rows: Partial<AgentSettings>[], users: Record<string, typeof BOT | null> = { [BOT.id]: BOT }, env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-test' }) {
    const store = new Map<string, AgentSettings>(rows.map((r) => [r.id!, { enabled: false, botUserId: null, model: null, settings: defaultSettings(r.id as AgentId), updatedAt: new Date(), ...r } as AgentSettings]));
    const records = {
        find: vi.fn(async () => [...store.values()]),
        findOneBy: vi.fn(async ({ id }: { id: string }) => store.get(id) ?? null),
    };
    const users_ = { findProfile: vi.fn(async (id: string) => users[id] ?? null) };
    const runtime = new AgentRuntimeService(records as never, users_ as never, env);
    return { runtime, store, users: users_ };
}

const gilde = { id: 'gilde' as const, enabled: true, model: 'openai/gpt-x', settings: { maxSteps: 12 } };
const scout = { id: 'verkenner' as const, enabled: true, botUserId: BOT.id, settings: { ...defaultSettings('verkenner'), dailySuggestions: 7 } };

describe('AgentRuntimeService status', () => {
    it('is on for a valid bot agent, with the model of the co-pilot as fallback and the parsers\' config', async () => {
        const { runtime } = setup([gilde, scout]);
        const agent = await runtime.effective('verkenner');
        expect(agent).toMatchObject({ status: 'on', reason: null, effectiveModel: 'openai/gpt-x', botUser: { id: BOT.id, email: BOT.email } });
        expect(agent.config).toMatchObject({ enabled: true, dailySuggestions: 7, maxSteps: 12, userEmail: BOT.email });
        expect(await runtime.scoutSetup()).toMatchObject({ user: { id: BOT.id } });
    });

    it('uses the agent\'s own model when it has one', async () => {
        const { runtime } = setup([gilde, { ...scout, model: 'openai/own' }]);
        expect((await runtime.effective('verkenner')).effectiveModel).toBe('openai/own');
    });

    it('is off when not enabled, and a missing record counts as off', async () => {
        const { runtime } = setup([gilde, { ...scout, enabled: false }]);
        expect(await runtime.effective('verkenner')).toMatchObject({ status: 'off', reason: null });
        expect(await runtime.scoutSetup()).toBeNull();
        expect((await runtime.effective('verfijner')).status).toBe('off');
    });

    it('is misconfigured, with the reason, for a missing bot user, a deleted user and a user that is not a bot', async () => {
        expect(await setup([gilde, { ...scout, botUserId: null }]).runtime.effective('verkenner')).toMatchObject({ status: 'misconfigured', reason: 'No bot user is chosen' });
        expect(await setup([gilde, scout], {}).runtime.effective('verkenner')).toMatchObject({ status: 'misconfigured', reason: 'The chosen bot user no longer exists' });
        const human = setup([gilde, scout], { [BOT.id]: { ...BOT, isBot: false } });
        const agent = await human.runtime.effective('verkenner');
        expect(agent.status).toBe('misconfigured');
        expect(agent.reason).toContain('is not marked as a bot');
        expect(await human.runtime.scoutSetup()).toBeNull();
    });

    it('is misconfigured when the model or the LLM key is missing, without naming env variables or a secret', async () => {
        const noModel = await setup([{ ...gilde, model: null }, scout]).runtime.effective('verkenner');
        expect(noModel).toMatchObject({ status: 'misconfigured', reason: 'No model is set (neither for this agent nor for the co-pilot)' });
        const badModel = await setup([gilde, { ...scout, model: 'gpt-x' }]).runtime.effective('verkenner');
        expect(badModel.reason).toContain('openai/<model>');
        const noKey = await setup([gilde, scout], undefined, {}).runtime.effective('verkenner');
        expect(noKey).toMatchObject({ status: 'misconfigured', reason: 'OPENAI_API_KEY is not set' });
        const coPilot = await setup([{ ...gilde, model: null }]).runtime.effective('gilde');
        expect(coPilot).toMatchObject({ status: 'misconfigured', reason: 'No model is set' });
    });

    it('is misconfigured for invalid stored settings', async () => {
        const { runtime } = setup([gilde, { ...scout, settings: { ...defaultSettings('verkenner'), summaryHourUtc: 99 } }]);
        const agent = await runtime.effective('verkenner');
        expect(agent.status).toBe('misconfigured');
        expect(agent.reason).toContain('summaryHourUtc');
    });

    it('is disabled_by_env for AGENTS_DISABLED, whatever the record says, and keeps the record\'s settings visible', async () => {
        const { runtime } = setup([gilde, scout], undefined, { OPENAI_API_KEY: 'sk-test', AGENTS_DISABLED: 'verkenner' });
        expect(await runtime.effective('verkenner')).toMatchObject({ status: 'disabled_by_env', enabled: true });
        expect((await runtime.effective('gilde')).status).toBe('on');
        expect(await runtime.scoutSetup()).toBeNull();
        expect(runtime.isDisabledByEnv('verkenner')).toBe(true);
        expect(setup([gilde], undefined, { AGENTS_DISABLED: 'all' }).runtime.isDisabledByEnv('gilde')).toBe(true);
    });

    it('keeps the MCP server off whatever the record says unless MCP_ENABLED is true', async () => {
        const row = { id: 'mcp' as const, enabled: true };
        expect(await setup([row], undefined, {}).runtime.effective('mcp')).toMatchObject({ status: 'disabled_by_env' });
        expect(await setup([row], undefined, { MCP_ENABLED: 'false' }).runtime.effective('mcp')).toMatchObject({ status: 'disabled_by_env' });
        expect(await setup([row], undefined, { MCP_ENABLED: 'true' }).runtime.effective('mcp')).toMatchObject({ status: 'on' });
        expect(await setup([{ ...row, enabled: false }], undefined, { MCP_ENABLED: 'true' }).runtime.effective('mcp')).toMatchObject({ status: 'off' });
    });

    it('never puts a secret in the state', async () => {
        const { runtime } = setup([gilde, scout], undefined, { OPENAI_API_KEY: 'sk-secret-value' });
        expect(JSON.stringify((await runtime.all()).map(({ config, ...rest }) => rest))).not.toContain('sk-secret-value');
    });
});

describe('AgentRuntimeService reads on each call, without a restart', () => {
    it('sees a changed setting, a newly created bot user and a deleted one at the next call', async () => {
        const { runtime, store, users } = setup([gilde, scout], {});
        expect((await runtime.effective('verkenner')).status).toBe('misconfigured');
        users.findProfile.mockImplementation(async (id: string) => (id === BOT.id ? BOT : null)); // the bot user is created later
        expect((await runtime.effective('verkenner')).status).toBe('on');
        store.get('verkenner')!.settings = { ...store.get('verkenner')!.settings, maxWakesPerDay: 2 };
        expect((await runtime.scoutSetup())!.config.maxWakesPerDay).toBe(2);
        store.get('verkenner')!.enabled = false;
        expect(await runtime.scoutSetup()).toBeNull();
        expect(runtime.peek('verkenner')!.status).toBe('off');
    });

    it('resolves the model per run and refuses a run while the agent is not on', async () => {
        const { runtime, store } = setup([gilde, scout]);
        const resolve = runtime.resolver('verkenner');
        expect(await resolve()).toEqual({ model: 'openai/gpt-x', maxSteps: 12 });
        store.get('gilde')!.model = 'openai/other';
        expect((await resolve()).model).toBe('openai/other');
        store.get('verkenner')!.botUserId = null;
        await expect(resolve()).rejects.toThrow('is not on: No bot user is chosen');
    });
});
