export const DEFAULT_MCP_DAILY_JOB_LIMIT = 20;
export const DEFAULT_MCP_DAILY_FEATURE_LIMIT = 5;

export interface McpConfig {
    enabled: boolean;
    /** Jobs one user may create through MCP per UTC day, across all projects and credentials (planned-feature jobs included). */
    dailyJobLimit: number;
    /** Features one user may create through MCP per UTC day. */
    dailyFeatureLimit: number;
}

/** Unset: the default. Set: a non-negative safe integer in plain digits (0 disables creation); anything else is invalid. */
function limit(name: string, raw: string | undefined, fallback: number): number {
    if (raw === undefined) return fallback;
    const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a non-negative integer (0 disables creating), got an invalid value`);
    return value;
}

/**
 * MCP is off unless MCP_ENABLED is literally `true`. The daily limits fail closed: an invalid value throws at startup
 * (also while MCP is off) instead of silently lifting the limit. Error messages never contain the raw value.
 */
export function mcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
    return {
        enabled: env.MCP_ENABLED === 'true',
        dailyJobLimit: limit('MCP_DAILY_JOB_LIMIT', env.MCP_DAILY_JOB_LIMIT, DEFAULT_MCP_DAILY_JOB_LIMIT),
        dailyFeatureLimit: limit('MCP_DAILY_FEATURE_LIMIT', env.MCP_DAILY_FEATURE_LIMIT, DEFAULT_MCP_DAILY_FEATURE_LIMIT),
    };
}
