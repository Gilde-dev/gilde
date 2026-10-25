export const COPILOT_MODEL_PREFIX = 'openai/';

export const DEFAULT_COPILOT_MAX_STEPS = 30;

export type CopilotConfig =
    | { enabled: true; model: string; maxSteps?: number }
    | { enabled: false; model: null; reason: string };

/**
 * The co-pilot needs an OpenAI key and an explicit model id in Mastra model router format
 * (`openai/<model>`). There is no default model, so the choice is always deliberate.
 * Another provider later only needs a different COPILOT_MODEL and its own key.
 */
export function copilotConfig(env: NodeJS.ProcessEnv = process.env): CopilotConfig {
    const model = env.COPILOT_MODEL?.trim();
    const key = env.OPENAI_API_KEY?.trim();
    if (!model) return disabled('COPILOT_MODEL is not set');
    if (!model.startsWith(COPILOT_MODEL_PREFIX) || model.length === COPILOT_MODEL_PREFIX.length) {
        return disabled(`COPILOT_MODEL must be an OpenAI model id in the form ${COPILOT_MODEL_PREFIX}<model>`);
    }
    if (!key) return disabled('OPENAI_API_KEY is not set');
    return { enabled: true, model, maxSteps: copilotMaxSteps(env) };
}

/** COPILOT_MAX_STEPS: a positive integer, otherwise the default. */
export function copilotMaxSteps(env: NodeJS.ProcessEnv = process.env): number {
    const value = Number(env.COPILOT_MAX_STEPS?.trim());
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_COPILOT_MAX_STEPS;
}

function disabled(reason: string): CopilotConfig {
    return { enabled: false, model: null, reason };
}
