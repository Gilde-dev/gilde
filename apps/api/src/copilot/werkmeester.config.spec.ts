import { planConfig } from './werkmeester.config.js';
import { resolvePlanSetup } from './werkmeester.setup.js';

const valid = { PLAN_ENABLED: 'true', PLAN_USER_EMAIL: 'werkmeester@example.com', PLAN_MODEL: 'openai/plan-model', OPENAI_API_KEY: 'sk-secret-value' };

describe('planConfig', () => {
    it('is on with the flag, user, model and key', () => {
        expect(planConfig(valid)).toEqual({ enabled: true, model: 'openai/plan-model', userEmail: 'werkmeester@example.com', dailyLimit: 5, maxSteps: 30 });
    });

    it('falls back to COPILOT_MODEL, and PLAN_MODEL wins when both are set', () => {
        const { PLAN_MODEL: _unused, ...rest } = valid;
        expect(planConfig({ ...rest, COPILOT_MODEL: 'openai/copilot-model' })).toMatchObject({ enabled: true, model: 'openai/copilot-model' });
        expect(planConfig({ ...valid, COPILOT_MODEL: 'openai/copilot-model' })).toMatchObject({ model: 'openai/plan-model' });
    });

    it.each(['', 'false', '1', 'TRUE', 'yes'])('is off unless PLAN_ENABLED is literally true (%j)', (flag) => {
        expect(planConfig({ ...valid, PLAN_ENABLED: flag })).toMatchObject({ enabled: false, model: null });
    });

    it('is off without a user, model or provider key, or with an unsupported model, and never names a secret', () => {
        expect(planConfig({ ...valid, PLAN_USER_EMAIL: ' ' })).toMatchObject({ enabled: false, reason: expect.stringContaining('PLAN_USER_EMAIL') });
        expect(planConfig({ PLAN_ENABLED: 'true', PLAN_USER_EMAIL: 'a@b.c', OPENAI_API_KEY: 'k' })).toMatchObject({ enabled: false, reason: expect.stringContaining('PLAN_MODEL') });
        expect(planConfig({ ...valid, PLAN_MODEL: 'anthropic/x' })).toMatchObject({ enabled: false });
        const noKey = planConfig({ ...valid, OPENAI_API_KEY: '' });
        expect(noKey).toMatchObject({ enabled: false, reason: expect.stringContaining('OPENAI_API_KEY') });
        expect(JSON.stringify(planConfig({ ...valid, PLAN_MODEL: 'anthropic/x' }))).not.toContain('sk-secret-value');
    });
});

describe('resolvePlanSetup', () => {
    const logger = { log: vi.fn(), warn: vi.fn() };
    const users = (user: unknown, identity: unknown) => ({ findByEmail: vi.fn().mockResolvedValue(user), findIdentity: vi.fn().mockResolvedValue(identity) });
    beforeEach(() => vi.clearAllMocks());

    it('is on for an existing bot user', async () => {
        const setup = await resolvePlanSetup(users({ id: 'u1', name: 'W', email: 'werkmeester@example.com' }, { isBot: true }) as never, valid, logger);
        expect(setup).toMatchObject({ user: { id: 'u1' }, config: { enabled: true } });
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('stays off with a clear log line for a missing user, a human account, a failing lookup and a bad environment, and never throws', async () => {
        expect(await resolvePlanSetup(users(null, null) as never, valid, logger)).toBeNull();
        expect(logger.warn).toHaveBeenLastCalledWith(expect.stringContaining('does not match an existing user'));
        expect(await resolvePlanSetup(users({ id: 'u1', name: 'H', email: 'h@example.com' }, { isBot: false }) as never, valid, logger)).toBeNull();
        expect(logger.warn).toHaveBeenLastCalledWith(expect.stringContaining('not a bot user'));
        const failing = { findByEmail: vi.fn().mockRejectedValue(new Error('db down')), findIdentity: vi.fn() };
        expect(await resolvePlanSetup(failing as never, valid, logger)).toBeNull();
        expect(logger.warn).toHaveBeenLastCalledWith(expect.stringContaining('db down'));
        expect(await resolvePlanSetup(users(null, null) as never, { PLAN_ENABLED: 'true' }, logger)).toBeNull();
        expect(logger.warn).toHaveBeenLastCalledWith(expect.stringContaining('PLAN_USER_EMAIL is not set'));
        expect(await resolvePlanSetup(users(null, null) as never, {}, logger)).toBeNull();
        expect(logger.log).toHaveBeenLastCalledWith(expect.stringContaining('PLAN_ENABLED is not "true"'));
    });

    it('reads PLAN_DAILY_LIMIT and fails closed on an invalid value', () => {
        expect(planConfig({ ...valid, PLAN_DAILY_LIMIT: '12' })).toMatchObject({ enabled: true, dailyLimit: 12 });
        expect(planConfig({ ...valid, PLAN_DAILY_LIMIT: ' ' })).toMatchObject({ enabled: true, dailyLimit: 5 });
        for (const bad of ['0', '-1', '1.5', 'abc', '5x', '99999999999999999999']) {
            expect(planConfig({ ...valid, PLAN_DAILY_LIMIT: bad })).toMatchObject({ enabled: false, reason: expect.stringContaining('PLAN_DAILY_LIMIT') });
        }
    });
});
