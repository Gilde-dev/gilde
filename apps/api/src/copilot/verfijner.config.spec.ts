import { refineConfig } from './verfijner.config.js';

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
