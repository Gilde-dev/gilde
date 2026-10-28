import { LESSON_PATTERN_MIN_SIZE } from '../lesson/lesson.dto.js';

import { COPILOT_MODEL_PREFIX, copilotMaxSteps } from './copilot.config.js';

export const SCOUT_AGENT_ID = 'verkenner';

export const DEFAULT_SCOUT_SUMMARY_HOUR_UTC = 6;
export const DEFAULT_SCOUT_MAX_WAKES_PER_DAY = 6;
export const DEFAULT_SCOUT_DAILY_SUGGESTIONS = 3;
export const DEFAULT_SCOUT_PATTERN_MIN_SIZE = 4;

export type ScoutConfig =
    | {
          enabled: true;
          model: string;
          /** Email of the existing bot user the scout acts as; resolved to a user by the module. */
          userEmail: string;
          summaryHourUtc: number;
          maxWakesPerDay: number;
          dailySuggestions: number;
          /** Smallest lesson pattern the scout may suggest a skill for. */
          patternMinSize: number;
          maxSteps: number;
      }
    | { enabled: false; model: null; reason: string };

/**
 * The scout (Verkenner) is opt-in. It is on only when SCOUT_ENABLED is literally `true`, SCOUT_USER_EMAIL is set,
 * SCOUT_MODEL (fallback COPILOT_MODEL) is an `openai/<model>` id and OPENAI_API_KEY is present. It is configured
 * independently of the human co-pilot. An explicit invalid number disables the scout instead of being guessed;
 * a missing one takes the default. Reasons never contain secret values.
 */
export function scoutConfig(env: NodeJS.ProcessEnv = process.env): ScoutConfig {
    if (env.SCOUT_ENABLED?.trim() !== 'true') return disabled('SCOUT_ENABLED is not "true"');

    const userEmail = env.SCOUT_USER_EMAIL?.trim();
    if (!userEmail) return disabled('SCOUT_USER_EMAIL is not set');

    const model = (env.SCOUT_MODEL?.trim() || env.COPILOT_MODEL?.trim()) ?? '';
    if (!model) return disabled('SCOUT_MODEL (or COPILOT_MODEL) is not set');
    if (!model.startsWith(COPILOT_MODEL_PREFIX) || model.length === COPILOT_MODEL_PREFIX.length) {
        return disabled(`SCOUT_MODEL must be an OpenAI model id in the form ${COPILOT_MODEL_PREFIX}<model>`);
    }
    if (!env.OPENAI_API_KEY?.trim()) return disabled('OPENAI_API_KEY is not set');

    const summaryHourUtc = integerSetting(env.SCOUT_SUMMARY_HOUR_UTC, DEFAULT_SCOUT_SUMMARY_HOUR_UTC, 0, 23);
    if (summaryHourUtc === null) return disabled('SCOUT_SUMMARY_HOUR_UTC must be an integer from 0 to 23');
    const maxWakesPerDay = integerSetting(env.SCOUT_MAX_WAKES_PER_DAY, DEFAULT_SCOUT_MAX_WAKES_PER_DAY, 1);
    if (maxWakesPerDay === null) return disabled('SCOUT_MAX_WAKES_PER_DAY must be a positive integer');
    const dailySuggestions = integerSetting(env.SCOUT_DAILY_SUGGESTIONS, DEFAULT_SCOUT_DAILY_SUGGESTIONS, 1);
    if (dailySuggestions === null) return disabled('SCOUT_DAILY_SUGGESTIONS must be a positive integer');

    const patternMinSize = integerSetting(env.SCOUT_PATTERN_MIN_SIZE, DEFAULT_SCOUT_PATTERN_MIN_SIZE, LESSON_PATTERN_MIN_SIZE, 100);
    if (patternMinSize === null) return disabled(`SCOUT_PATTERN_MIN_SIZE must be an integer from ${LESSON_PATTERN_MIN_SIZE} to 100`);

    return { enabled: true, model, userEmail, summaryHourUtc, maxWakesPerDay, dailySuggestions, patternMinSize, maxSteps: copilotMaxSteps(env) };
}

/** Missing or blank: the default. Present but not an integer in range: null (invalid). */
function integerSetting(raw: string | undefined, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number | null {
    const text = raw?.trim();
    if (!text) return fallback;
    if (!/^\d+$/.test(text)) return null;
    const value = Number(text);
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function disabled(reason: string): ScoutConfig {
    return { enabled: false, model: null, reason };
}
