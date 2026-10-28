import { refineConfig } from './verfijner.config.js';
import { resolveRefineSetup } from './verfijner.setup.js';

const valid = { REFINE_ENABLED: 'true', REFINE_USER_EMAIL: 'verfijner@example.com', REFINE_MODEL: 'openai/refine-model', OPENAI_API_KEY: 'sk-secret-value' };

describe('refineConfig', () => {
    it('is on with the flag, user, model and key, and applies the default daily limit', () => {
        expect(refineConfig(valid)).toEqual({ enabled: true, model: 'openai/refine-model', userEmail: 'verfijner@example.com', dailyLimit: 10, maxSteps: 30 });
    });

    it('falls back to COPILOT_MODEL, and REFINE_MODEL wins when both are set', () => {
        const { REFINE_MODEL: _unused, ...rest } = valid;
        expect(refineConfig({ ...rest, COPILOT_MODEL: 'openai/copilot-model' })).toMatchObject({ enabled: true, model: 'openai/copilot-model' });
        expect(refineConfig({ ...valid, COPILOT_MODEL: 'openai/copilot-model' })).toMatchObject({ model: 'openai/refine-model' });
    });

    it.each(['', 'false', '1', 'TRUE', 'yes'])('is off unless REFINE_ENABLED is literally true (%j)', (flag) => {
        expect(refineConfig({ ...valid, REFINE_ENABLED: flag })).toMatchObject({ enabled: false, model: null });
    });

    it('is off without a user, model or provider key, or with an unsupported model', () => {
        expect(refineConfig({ ...valid, REFINE_USER_EMAIL: ' ' })).toMatchObject({ enabled: false, reason: expect.stringContaining('REFINE_USER_EMAIL') });
        expect(refineConfig({ REFINE_ENABLED: 'true', REFINE_USER_EMAIL: 'a@b.c', OPENAI_API_KEY: 'k' })).toMatchObject({ enabled: false, reason: expect.stringContaining('REFINE_MODEL') });
        expect(refineConfig({ ...valid, REFINE_MODEL: 'anthropic/x' })).toMatchObject({ enabled: false });
        expect(refineConfig({ ...valid, OPENAI_API_KEY: '' })).toMatchObject({ enabled: false, reason: expect.stringContaining('OPENAI_API_KEY') });
    });

    it('takes a valid daily limit and fails closed on an invalid one', () => {
        expect(refineConfig({ ...valid, REFINE_DAILY_LIMIT: '3' })).toMatchObject({ enabled: true, dailyLimit: 3 });
        expect(refineConfig({ ...valid, REFINE_DAILY_LIMIT: '  ' })).toMatchObject({ enabled: true, dailyLimit: 10 });
        for (const bad of ['0', '-1', '1.5', 'ten', '1e3', '99999999999999999999']) {
            expect(refineConfig({ ...valid, REFINE_DAILY_LIMIT: bad })).toMatchObject({ enabled: false, reason: expect.stringContaining('REFINE_DAILY_LIMIT') });
        }
    });

    it('never puts secrets in a reason', () => {
        const config = refineConfig({ ...valid, REFINE_MODEL: 'nope' });
        expect(JSON.stringify(config)).not.toContain('sk-secret-value');
    });
});

describe('resolveRefineSetup', () => {
    const logger = { log: vi.fn(), warn: vi.fn() };
    const user = { id: 'u1', name: 'Verfijner', email: 'verfijner@example.com' };
    beforeEach(() => { logger.log.mockClear(); logger.warn.mockClear(); });

    it('is on for an existing bot user', async () => {
        const users = { findByEmail: vi.fn().mockResolvedValue(user), findIdentity: vi.fn().mockResolvedValue({ id: 'u1', email: user.email, isBot: true }) };
        const setup = await resolveRefineSetup(users, valid, logger);
        expect(setup).toMatchObject({ user, config: { enabled: true, dailyLimit: 10 } });
    });

    it('is off, without throwing, for a human user, an unknown user, a lookup error or a bad config', async () => {
        const human = { findByEmail: vi.fn().mockResolvedValue(user), findIdentity: vi.fn().mockResolvedValue({ id: 'u1', email: user.email, isBot: false }) };
        expect(await resolveRefineSetup(human, valid, logger)).toBeNull();
        expect(logger.warn).toHaveBeenLastCalledWith(expect.stringContaining('not a bot'));
        expect(await resolveRefineSetup({ ...human, findByEmail: vi.fn().mockResolvedValue(null) }, valid, logger)).toBeNull();
        expect(await resolveRefineSetup({ ...human, findByEmail: vi.fn().mockRejectedValue(new Error('db down')) }, valid, logger)).toBeNull();
        expect(await resolveRefineSetup(human, { ...valid, REFINE_DAILY_LIMIT: 'x' }, logger)).toBeNull();
        expect(logger.warn).toHaveBeenLastCalledWith(expect.stringContaining('REFINE_DAILY_LIMIT'));
        expect(human.findByEmail).toHaveBeenCalledTimes(1); // the bad config never reached the lookup
    });

    it('logs a plain info line (no warning) when it is simply not enabled', async () => {
        expect(await resolveRefineSetup({} as never, {}, logger)).toBeNull();
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('REFINE_ENABLED'));
    });
});
