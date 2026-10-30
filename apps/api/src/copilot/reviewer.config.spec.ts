import { reviewerConfig } from './reviewer.config.js';

const valid = { REVIEWER_ENABLED: 'true', REVIEWER_MODEL: 'openai/review-model', OPENAI_API_KEY: 'sk-secret-value' };

describe('reviewerConfig', () => {
    it('is on with the flag, model and key, with the five default limits', () => {
        expect(reviewerConfig(valid)).toEqual({ enabled: true, model: 'openai/review-model', timeoutSeconds: 300, maxSteps: 12, maxInputTokens: 60000, maxOutputTokens: 4000, maxRevisions: 2 });
    });

    it('takes all five limits from the environment', () => {
        const env = { ...valid, REVIEWER_TIMEOUT_SECONDS: '60', REVIEWER_MAX_STEPS: '3', REVIEWER_MAX_INPUT_TOKENS: '1000', REVIEWER_MAX_OUTPUT_TOKENS: '500', REVIEWER_MAX_REVISIONS: '1' };
        expect(reviewerConfig(env)).toMatchObject({ timeoutSeconds: 60, maxSteps: 3, maxInputTokens: 1000, maxOutputTokens: 500, maxRevisions: 1 });
    });

    it('falls back to COPILOT_MODEL, and REVIEWER_MODEL wins when both are set', () => {
        const { REVIEWER_MODEL: _unused, ...rest } = valid;
        expect(reviewerConfig({ ...rest, COPILOT_MODEL: 'openai/copilot' })).toMatchObject({ enabled: true, model: 'openai/copilot' });
        expect(reviewerConfig({ ...valid, COPILOT_MODEL: 'openai/copilot' })).toMatchObject({ model: 'openai/review-model' });
    });

    it.each(['', 'false', '1', 'TRUE'])('is off unless REVIEWER_ENABLED is literally true (%j)', (flag) => {
        expect(reviewerConfig({ ...valid, REVIEWER_ENABLED: flag })).toMatchObject({ enabled: false, model: null });
    });

    it('is off without a model or key, or with an unsupported model, and never names a secret', () => {
        expect(reviewerConfig({ REVIEWER_ENABLED: 'true', OPENAI_API_KEY: 'k' })).toMatchObject({ enabled: false, reason: expect.stringContaining('REVIEWER_MODEL') });
        expect(reviewerConfig({ ...valid, REVIEWER_MODEL: 'anthropic/x' })).toMatchObject({ enabled: false });
        expect(reviewerConfig({ ...valid, OPENAI_API_KEY: '' })).toMatchObject({ enabled: false, reason: expect.stringContaining('OPENAI_API_KEY') });
        expect(JSON.stringify(reviewerConfig({ ...valid, REVIEWER_MODEL: 'anthropic/x' }))).not.toContain('sk-secret-value');
    });

    it.each(['0', '-1', '1.5', 'abc', 'Infinity', '9007199254740993', '1e3'])('fails closed on an invalid limit %j', (value) => {
        for (const name of ['REVIEWER_TIMEOUT_SECONDS', 'REVIEWER_MAX_STEPS', 'REVIEWER_MAX_INPUT_TOKENS', 'REVIEWER_MAX_OUTPUT_TOKENS', 'REVIEWER_MAX_REVISIONS']) {
            expect(reviewerConfig({ ...valid, [name]: value }), name).toMatchObject({ enabled: false, reason: `${name} must be a positive whole number` });
        }
    });
});
