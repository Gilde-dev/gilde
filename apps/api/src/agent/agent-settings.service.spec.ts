import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AgentRuntimeService } from './agent-runtime.service.js';
import type { AgentSettingsAudit } from './agent-settings-audit.entity.js';
import type { AgentSettings } from './agent-settings.entity.js';
import { AgentSettingsService } from './agent-settings.service.js';
import { defaultSettings } from './agent-settings.js';
import { AGENT_IDS } from './agent-ids.js';

const BOT = { id: '11111111-1111-4111-8111-111111111111', name: 'Bot', email: 'scout@example.com', isBot: true };
const PLAIN = { id: '33333333-3333-4333-8333-333333333333', name: 'Plain', email: 'plain@example.com', isBot: false };
const HUMAN = { id: '22222222-2222-4222-8222-222222222222', name: 'Human', email: 'human@example.com', isBot: false };

function harness(env: NodeJS.ProcessEnv = {}, existing: Partial<AgentSettings>[] = []) {
    const store = new Map<string, AgentSettings>(existing.map((r) => [r.id!, { enabled: false, botUserId: null, model: null, settings: {}, ...r } as AgentSettings]));
    const audit: Array<Partial<AgentSettingsAudit>> = [];
    const records = {
        find: vi.fn(async () => [...store.values()]),
        findOneBy: vi.fn(async ({ id }: { id: string }) => store.get(id) ?? null),
        insert: vi.fn(async (row: AgentSettings) => { store.set(row.id, { updatedAt: new Date(), ...row }); }),
        update: vi.fn(async ({ id }: { id: string }, patch: Partial<AgentSettings>) => { Object.assign(store.get(id)!, patch); }),
    };
    const auditRepo = { find: vi.fn(async () => audit.map((a, i) => ({ id: String(i), createdAt: new Date(), ...a })).reverse()) };
    const dataSource = { transaction: async (fn: (m: unknown) => Promise<void>) => fn({ getRepository: (entity: { name: string }) => (entity.name === 'AgentSettings' ? records : { insert: async (rows: Array<Partial<AgentSettingsAudit>>) => { audit.push(...rows); } }) }) };
    const people: Record<string, typeof BOT> = { [BOT.id]: BOT, [HUMAN.id]: HUMAN, [PLAIN.id]: PLAIN };
    const admins = new Set<string>([HUMAN.id]);
    const users = {
        findByEmail: vi.fn(async (email: string) => Object.values(people).find((u) => u.email === email.toLowerCase()) ?? null),
        findProfile: vi.fn(async (id: string) => people[id] ?? null),
        listBots: vi.fn(async () => Object.values(people).filter((u) => u.isBot)),
        requireAdmin: vi.fn(async (user?: { id: string; credential?: string }) => {
            if (user?.credential !== 'jwt' || people[user.id]?.isBot !== false) throw new ForbiddenException('A verified human is required');
            if (!admins.has(user.id)) throw new ForbiddenException('Only admins can do this');
            return people[user.id]!;
        }),
    };
    const runtime = new AgentRuntimeService(records as never, users as never, env);
    const service = new AgentSettingsService(records as never, auditRepo as never, dataSource as never, users as never, runtime, env);
    return { service, runtime, store, audit, records, users };
}

const jwt = { id: HUMAN.id, name: HUMAN.name, email: HUMAN.email, credential: 'jwt' as const };

describe('seeding from the environment', () => {
    const env = {
        OPENAI_API_KEY: 'sk-x', COPILOT_MODEL: 'openai/main', COPILOT_MAX_STEPS: '12',
        SCOUT_ENABLED: 'true', SCOUT_USER_EMAIL: 'Scout@Example.com', SCOUT_MODEL: 'openai/scout', SCOUT_DAILY_SUGGESTIONS: '9',
        REFINE_ENABLED: 'true', REFINE_USER_EMAIL: 'nobody@example.com', REFINE_DAILY_LIMIT: 'abc',
        MCP_DAILY_JOB_LIMIT: '7', DISPATCH_LESSONS_TOP_K: '2',
    };

    it('creates a record per agent from the variables, resolving the bot user, with defaults for the rest', async () => {
        const { service, store } = harness(env);
        expect(await service.seed()).toEqual([...AGENT_IDS]);
        expect(store.get('gilde')).toMatchObject({ enabled: true, model: 'openai/main', settings: { maxSteps: 12 } });
        expect(store.get('verkenner')).toMatchObject({ enabled: true, botUserId: BOT.id, model: 'openai/scout', settings: { ...defaultSettings('verkenner'), dailySuggestions: 9 } });
        expect(store.get('werkmeester')).toMatchObject({ enabled: false, botUserId: null, model: null, settings: defaultSettings('werkmeester') });
        expect(store.get('mcp')).toMatchObject({ enabled: true, settings: { ...defaultSettings('mcp'), dailyJobLimit: 7 } });
        expect(store.get('coding')).toMatchObject({ enabled: true, settings: { ...defaultSettings('coding'), lessonsTopK: 2 } });
    });

    it('seeds an invalid number with the default and, for the agents that failed closed, switched off', async () => {
        const { service, store } = harness(env);
        await service.seed();
        // REFINE_USER_EMAIL does not exist and REFINE_DAILY_LIMIT is invalid.
        expect(store.get('verfijner')).toMatchObject({ enabled: false, botUserId: null, settings: defaultSettings('verfijner') });
        const lenient = harness({ DISPATCH_LESSONS_TOP_K: 'x' });
        await lenient.service.seed();
        expect(lenient.store.get('coding')).toMatchObject({ enabled: true, settings: defaultSettings('coding') });
    });

    it('seeds the co-pilot off without a model', async () => {
        const { service, store } = harness({});
        await service.seed();
        expect(store.get('gilde')).toMatchObject({ enabled: false, model: null });
    });

    it('never overwrites an existing record from the environment, and seeds only the missing ones', async () => {
        const { service, store, records } = harness(env, [{ id: 'verkenner', enabled: false, model: 'openai/kept', settings: { ...defaultSettings('verkenner'), dailySuggestions: 1 } }]);
        const created = await service.seed();
        expect(created).not.toContain('verkenner');
        expect(store.get('verkenner')).toMatchObject({ enabled: false, model: 'openai/kept', settings: { dailySuggestions: 1 } });
        expect(records.insert).toHaveBeenCalledTimes(AGENT_IDS.length - 1);
        expect(await service.seed()).toEqual([]); // and a second start creates nothing
    });

    it('writes no audit entry for the seed', async () => {
        const { service, audit } = harness(env);
        await service.seed();
        expect(audit).toEqual([]);
    });
});

describe('replacing settings', () => {
    const body = (over: object = {}) => ({ enabled: true, botUserId: BOT.id, model: 'openai/new', settings: defaultSettings('verkenner'), ...over });
    const start = async () => {
        const h = harness({ OPENAI_API_KEY: 'sk-x', COPILOT_MODEL: 'openai/main', SCOUT_ENABLED: 'true', SCOUT_USER_EMAIL: BOT.email });
        await h.service.seed();
        return h;
    };

    it('audits each changed field with old and new value, who and when, and takes effect immediately', async () => {
        const { service, audit, runtime } = await start();
        const result = await service.replace(jwt, 'verkenner', body({ model: 'openai/new', settings: { ...defaultSettings('verkenner'), maxWakesPerDay: 2 } }));
        expect(result).toMatchObject({ status: 'on', effectiveModel: 'openai/new', settings: { maxWakesPerDay: 2 } });
        expect(audit).toEqual([
            { agent: 'verkenner', changedById: HUMAN.id, field: 'model', oldValue: null, newValue: '"openai/new"' },
            { agent: 'verkenner', changedById: HUMAN.id, field: 'settings.maxWakesPerDay', oldValue: '6', newValue: '2' },
        ]);
        expect((await runtime.scoutSetup())!.config.maxWakesPerDay).toBe(2);
        const trail = await service.auditOf('verkenner');
        expect(trail[0]).toMatchObject({ field: 'settings.maxWakesPerDay', changedBy: { id: HUMAN.id, name: 'Human', email: 'human@example.com' }, createdAt: expect.any(String) });
    });

    it('rejects invalid values per field and audits nothing', async () => {
        const { service, audit, store } = await start();
        const before = structuredClone(store.get('verkenner')!.settings);
        await expect(service.replace(jwt, 'verkenner', body({ settings: { ...defaultSettings('verkenner'), summaryHourUtc: 24, patternMinSize: 1 } }))).rejects.toMatchObject({
            response: { issues: expect.arrayContaining([{ path: 'settings.summaryHourUtc', message: 'Must be at most 23' }, { path: 'settings.patternMinSize', message: 'Must be at least 2' }]) },
        });
        await expect(service.replace(jwt, 'verkenner', body({ botUserId: HUMAN.id }))).rejects.toMatchObject({ response: { issues: [{ path: 'botUserId', message: 'Choose a user that is marked as a bot' }] } });
        await expect(service.replace(jwt, 'verkenner', body({ model: 'gpt' }))).rejects.toMatchObject({ response: { issues: [expect.objectContaining({ path: 'model' })] } });
        expect(audit).toEqual([]);
        expect(store.get('verkenner')!.settings).toEqual(before);
    });

    it('refuses everyone but an admin: API keys, bots and unauthenticated calls', async () => {
        const { service, audit } = await start();
        await expect(service.replace({ ...jwt, credential: 'api_key' }, 'verkenner', body())).rejects.toBeInstanceOf(ForbiddenException);
        await expect(service.replace({ ...jwt, id: BOT.id }, 'verkenner', body())).rejects.toBeInstanceOf(ForbiddenException);
        await expect(service.replace(undefined, 'verkenner', body())).rejects.toBeInstanceOf(ForbiddenException);
        expect(audit).toEqual([]);
    });

    it('refuses a verified human who is not an admin', async () => {
        const { service, audit } = await start();
        await expect(service.replace({ ...jwt, id: PLAIN.id }, 'verkenner', body())).rejects.toBeInstanceOf(ForbiddenException);
        expect(audit).toEqual([]);
    });

    it('does not audit an unchanged replacement', async () => {
        const { service, audit, store } = await start();
        const r = store.get('verkenner')!;
        await service.replace(jwt, 'verkenner', { enabled: r.enabled, botUserId: r.botUserId, model: r.model, settings: r.settings });
        expect(audit).toEqual([]);
    });

    it('lists the users marked as bots', async () => {
        const { service } = await start();
        expect(await service.botUsers()).toEqual([{ id: BOT.id, name: 'Bot', email: BOT.email }]);
    });
});
