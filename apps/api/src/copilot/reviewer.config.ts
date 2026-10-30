import { COPILOT_MODEL_PREFIX } from './copilot.config.js';

export const REVIEWER_AGENT_ID = 'reviewer';

export const DEFAULT_REVIEWER_TIMEOUT_SECONDS = 300;
export const DEFAULT_REVIEWER_MAX_STEPS = 12;
export const DEFAULT_REVIEWER_MAX_INPUT_TOKENS = 60_000;
export const DEFAULT_REVIEWER_MAX_OUTPUT_TOKENS = 4_000;
export const DEFAULT_REVIEWER_MAX_REVISIONS = 2;

export type ReviewerConfig =
    | {
          enabled: true;
          model: string;
          /** Wall-clock limit of one review, in seconds. */
          timeoutSeconds: number;
          /** Model steps per review. */
          maxSteps: number;
          /** Input tokens summed over all steps of one review. */
          maxInputTokens: number;
          /** Output tokens summed over all steps of one review. */
          maxOutputTokens: number;
          /** Automatic revision rounds per job. */
          maxRevisions: number;
      }
    | { enabled: false; model: null; reason: string };

/**
 * The reviewer is opt-in. It is on only when REVIEWER_ENABLED is literally `true`, REVIEWER_MODEL (fallback COPILOT_MODEL)
 * is an `openai/<model>` id and OPENAI_API_KEY is present. Each limit is a finite positive safe integer: missing or blank
 * takes the default, anything else invalid turns the reviewer off (fail closed). Reasons never contain secret values.
 */
export function reviewerConfig(env: NodeJS.ProcessEnv = process.env): ReviewerConfig {
    if (env.REVIEWER_ENABLED?.trim() !== 'true') return disabled('REVIEWER_ENABLED is not "true"');

    const model = (env.REVIEWER_MODEL?.trim() || env.COPILOT_MODEL?.trim()) ?? '';
    if (!model) return disabled('REVIEWER_MODEL (or COPILOT_MODEL) is not set');
    if (!model.startsWith(COPILOT_MODEL_PREFIX) || model.length === COPILOT_MODEL_PREFIX.length) {
        return disabled(`REVIEWER_MODEL must be an OpenAI model id in the form ${COPILOT_MODEL_PREFIX}<model>`);
    }
    if (!env.OPENAI_API_KEY?.trim()) return disabled('OPENAI_API_KEY is not set');

    const timeoutSeconds = positiveInteger(env.REVIEWER_TIMEOUT_SECONDS, DEFAULT_REVIEWER_TIMEOUT_SECONDS);
    const maxSteps = positiveInteger(env.REVIEWER_MAX_STEPS, DEFAULT_REVIEWER_MAX_STEPS);
    const maxInputTokens = positiveInteger(env.REVIEWER_MAX_INPUT_TOKENS, DEFAULT_REVIEWER_MAX_INPUT_TOKENS);
    const maxOutputTokens = positiveInteger(env.REVIEWER_MAX_OUTPUT_TOKENS, DEFAULT_REVIEWER_MAX_OUTPUT_TOKENS);
    const maxRevisions = positiveInteger(env.REVIEWER_MAX_REVISIONS, DEFAULT_REVIEWER_MAX_REVISIONS);
    if (timeoutSeconds === null) return invalid('REVIEWER_TIMEOUT_SECONDS');
    if (maxSteps === null) return invalid('REVIEWER_MAX_STEPS');
    if (maxInputTokens === null) return invalid('REVIEWER_MAX_INPUT_TOKENS');
    if (maxOutputTokens === null) return invalid('REVIEWER_MAX_OUTPUT_TOKENS');
    if (maxRevisions === null) return invalid('REVIEWER_MAX_REVISIONS');
    return { enabled: true, model, timeoutSeconds, maxSteps, maxInputTokens, maxOutputTokens, maxRevisions };
}

/** Missing or blank: the default. Present but not a positive safe integer: null (invalid, fail closed). */
function positiveInteger(raw: string | undefined, fallback: number): number | null {
    const text = raw?.trim();
    if (!text) return fallback;
    if (!/^\d+$/.test(text)) return null;
    const value = Number(text);
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

const invalid = (name: string): ReviewerConfig => disabled(`${name} must be a positive whole number`);

function disabled(reason: string): ReviewerConfig {
    return { enabled: false, model: null, reason };
}
