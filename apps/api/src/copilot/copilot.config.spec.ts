import { copilotConfig } from './copilot.config.js';

describe('copilotConfig', () => {
    it('is enabled with a key and an openai/ model', () => {
        expect(copilotConfig({ OPENAI_API_KEY: 'sk-x', COPILOT_MODEL: 'openai/some-model' })).toEqual({ enabled: true, model: 'openai/some-model' });
    });

    it('is disabled without a model, a key, or with another provider', () => {
        expect(copilotConfig({ OPENAI_API_KEY: 'sk-x' })).toMatchObject({ enabled: false, model: null, reason: expect.stringContaining('COPILOT_MODEL is not set') });
        expect(copilotConfig({ COPILOT_MODEL: 'openai/some-model' })).toMatchObject({ enabled: false, reason: expect.stringContaining('OPENAI_API_KEY') });
        expect(copilotConfig({ OPENAI_API_KEY: 'sk-x', COPILOT_MODEL: 'anthropic/other' })).toMatchObject({ enabled: false, reason: expect.stringContaining('openai/<model>') });
        expect(copilotConfig({ OPENAI_API_KEY: 'sk-x', COPILOT_MODEL: 'openai/' })).toMatchObject({ enabled: false });
        expect(copilotConfig({ OPENAI_API_KEY: ' ', COPILOT_MODEL: 'openai/m' })).toMatchObject({ enabled: false });
    });
});
