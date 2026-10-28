import { COPILOT_MODEL_PREFIX, copilotMaxSteps } from './copilot.config.js';

export const REFINE_AGENT_ID = 'verfijner';

export const DEFAULT_REFINE_DAILY_LIMIT = 10;

export type RefineConfig =
    | {
          enabled: true;
          model: string;
          /** Email of the existing bot user the Verfijner acts as; resolved to a user by the setup. */
          userEmail: string;
          /** Refine runs per project per UTC day. */
          dailyLimit: number;
          maxSteps: number;
      }
    | { enabled: false; model: null; reason: string };

/**
 * The Verfijner is opt-in. It is on only when REFINE_ENABLED is literally `true`, REFINE_USER_EMAIL is set, REFINE_MODEL
 * (fallback COPILOT_MODEL) is an `openai/<model>` id and OPENAI_API_KEY is present. An explicit invalid REFINE_DAILY_LIMIT
 * turns it off (fail closed) instead of being guessed; a missing one takes the default. Reasons never contain secret values.
 */
export function refineConfig(env: NodeJS.ProcessEnv = process.env): RefineConfig {
    if (env.REFINE_ENABLED?.trim() !== 'true') return disabled('REFINE_ENABLED is not "true"');

    const userEmail = env.REFINE_USER_EMAIL?.trim();
    if (!userEmail) return disabled('REFINE_USER_EMAIL is not set');

    const model = (env.REFINE_MODEL?.trim() || env.COPILOT_MODEL?.trim()) ?? '';
    if (!model) return disabled('REFINE_MODEL (or COPILOT_MODEL) is not set');
    if (!model.startsWith(COPILOT_MODEL_PREFIX) || model.length === COPILOT_MODEL_PREFIX.length) {
        return disabled(`REFINE_MODEL must be an OpenAI model id in the form ${COPILOT_MODEL_PREFIX}<model>`);
    }
    if (!env.OPENAI_API_KEY?.trim()) return disabled('OPENAI_API_KEY is not set');

    const dailyLimit = positiveInteger(env.REFINE_DAILY_LIMIT, DEFAULT_REFINE_DAILY_LIMIT);
    if (dailyLimit === null) return disabled('REFINE_DAILY_LIMIT must be a positive integer');

    return { enabled: true, model, userEmail, dailyLimit, maxSteps: copilotMaxSteps(env) };
}

/** Missing or blank: the default. Present but not a positive integer: null (invalid). */
function positiveInteger(raw: string | undefined, fallback: number): number | null {
    const text = raw?.trim();
    if (!text) return fallback;
    if (!/^\d+$/.test(text)) return null;
    const value = Number(text);
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function disabled(reason: string): RefineConfig {
    return { enabled: false, model: null, reason };
}
