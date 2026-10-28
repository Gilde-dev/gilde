export const DEFAULT_EXHAUSTED_BACKOFF_MINUTES = 60;
const MAX_EXHAUSTED_BACKOFF_MINUTES = 7 * 24 * 60;

/**
 * EXECUTOR_EXHAUSTED_BACKOFF_MINUTES: how long an executor stays exhausted when the usage-limit response gives no reset
 * time. Unset means 60; set but not an integer of 1..10080 throws, so the API fails closed at startup.
 */
export function parseExhaustedBackoffMinutes(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.EXECUTOR_EXHAUSTED_BACKOFF_MINUTES?.trim();
    if (!raw) return DEFAULT_EXHAUSTED_BACKOFF_MINUTES;
    const minutes = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_EXHAUSTED_BACKOFF_MINUTES) {
        throw new Error(`EXECUTOR_EXHAUSTED_BACKOFF_MINUTES must be an integer between 1 and ${MAX_EXHAUSTED_BACKOFF_MINUTES}.`);
    }
    return minutes;
}
