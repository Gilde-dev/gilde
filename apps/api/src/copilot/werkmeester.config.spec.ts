import { planConfig } from './werkmeester.config.js';

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
