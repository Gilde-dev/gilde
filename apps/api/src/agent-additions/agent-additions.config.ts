export const DEFAULT_AGENT_INSTRUCTIONS_MAX_CHARS = 4000;
const MAX_ALLOWED = 20_000;

/** Longest per-project addition in characters (AGENT_INSTRUCTIONS_MAX_CHARS, default 4000). An invalid value falls back to the default. */
export function agentInstructionsMaxChars(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.AGENT_INSTRUCTIONS_MAX_CHARS?.trim();
    if (!raw) return DEFAULT_AGENT_INSTRUCTIONS_MAX_CHARS;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= MAX_ALLOWED ? n : DEFAULT_AGENT_INSTRUCTIONS_MAX_CHARS;
}
