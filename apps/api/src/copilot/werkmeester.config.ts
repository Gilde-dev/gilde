import { COPILOT_MODEL_PREFIX, copilotMaxSteps } from './copilot.config.js';

export const PLAN_AGENT_ID = 'werkmeester';

export const DEFAULT_PLAN_DAILY_LIMIT = 5;

export type PlanConfig =
    | {
          enabled: true;
          model: string;
          /** Email of the existing bot user the Werkmeester acts as; resolved to a user by the setup. */
          userEmail: string;
          /** Planning runs per project per UTC day. */
          dailyLimit: number;
          maxSteps: number;
      }
    | { enabled: false; model: null; reason: string };

/**
 * The Werkmeester is opt-in. It is on only when PLAN_ENABLED is literally `true`, PLAN_USER_EMAIL is set, PLAN_MODEL
 * (fallback COPILOT_MODEL) is an `openai/<model>` id and OPENAI_API_KEY is present. An explicit invalid PLAN_DAILY_LIMIT
 * turns it off (fail closed); a missing one takes the default. Reasons never contain secret values.
 */
export function planConfig(env: NodeJS.ProcessEnv = process.env): PlanConfig {
    if (env.PLAN_ENABLED?.trim() !== 'true') return disabled('PLAN_ENABLED is not "true"');

    const userEmail = env.PLAN_USER_EMAIL?.trim();
    if (!userEmail) return disabled('PLAN_USER_EMAIL is not set');

    const model = (env.PLAN_MODEL?.trim() || env.COPILOT_MODEL?.trim()) ?? '';
    if (!model) return disabled('PLAN_MODEL (or COPILOT_MODEL) is not set');
    if (!model.startsWith(COPILOT_MODEL_PREFIX) || model.length === COPILOT_MODEL_PREFIX.length) {
        return disabled(`PLAN_MODEL must be an OpenAI model id in the form ${COPILOT_MODEL_PREFIX}<model>`);
    }
    if (!env.OPENAI_API_KEY?.trim()) return disabled('OPENAI_API_KEY is not set');

    const dailyLimit = positiveInteger(env.PLAN_DAILY_LIMIT, DEFAULT_PLAN_DAILY_LIMIT);
    if (dailyLimit === null) return disabled('PLAN_DAILY_LIMIT must be a positive integer');

    return { enabled: true, model, userEmail, dailyLimit, maxSteps: copilotMaxSteps(env) };
}

/** Missing or blank: the default. Present but not a positive integer: null (invalid, fail closed). */
function positiveInteger(raw: string | undefined, fallback: number): number | null {
    const text = raw?.trim();
    if (!text) return fallback;
    if (!/^\d+$/.test(text)) return null;
    const value = Number(text);
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function disabled(reason: string): PlanConfig {
    return { enabled: false, model: null, reason };
}
