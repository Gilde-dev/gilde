export const DEFAULT_AGENT_LOG_MAX_CHARS = 2000;
export const DEFAULT_AGENT_LOG_RETENTION_DAYS = 90;
const MAX_LOG_CHARS = 100_000;
const MAX_RETENTION_DAYS = 3650;

function intEnv(name: string, fallback: number, min: number, max: number, env: NodeJS.ProcessEnv): number {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
        throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
    }
    return n;
}

/** Cap of a recorded tool input or output in characters (AGENT_LOG_MAX_CHARS, default 2000). Throws on an invalid value. */
export const agentLogMaxChars = (env: NodeJS.ProcessEnv = process.env): number => intEnv('AGENT_LOG_MAX_CHARS', DEFAULT_AGENT_LOG_MAX_CHARS, 100, MAX_LOG_CHARS, env);

/** Days the run log is kept (AGENT_LOG_RETENTION_DAYS, default 90). Throws on an invalid value. */
export const agentLogRetentionDays = (env: NodeJS.ProcessEnv = process.env): number => intEnv('AGENT_LOG_RETENTION_DAYS', DEFAULT_AGENT_LOG_RETENTION_DAYS, 1, MAX_RETENTION_DAYS, env);
