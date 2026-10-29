import { LESSONS_MAX_COUNT } from '../execution/job-lessons.js';
import { DEFAULT_COPILOT_MAX_STEPS, COPILOT_MODEL_PREFIX } from '../copilot/copilot.config.js';
import { DEFAULT_SCOUT_DAILY_SUGGESTIONS, DEFAULT_SCOUT_MAX_WAKES_PER_DAY, DEFAULT_SCOUT_PATTERN_MIN_SIZE, DEFAULT_SCOUT_SUMMARY_HOUR_UTC } from '../copilot/verkenner.config.js';
import { DEFAULT_REFINE_DAILY_LIMIT } from '../copilot/verfijner.config.js';
import { DEFAULT_PLAN_DAILY_LIMIT } from '../copilot/werkmeester.config.js';
import { DEFAULT_MCP_DAILY_FEATURE_LIMIT, DEFAULT_MCP_DAILY_JOB_LIMIT } from '../mcp/mcp.config.js';
import { LESSON_PATTERN_MIN_SIZE } from '../lesson/lesson.dto.js';

import type { AgentId } from './agent-ids.js';

export interface SettingField {
    key: string;
    /** The environment variable this setting is seeded from. */
    env: string;
    label: string;
    kind: 'int' | 'number';
    min: number;
    max: number;
    default: number;
}

const INT_MAX = Number.MAX_SAFE_INTEGER;

/**
 * The runtime settings per agent: exactly the variables the spec lists. Ranges and defaults are those of the existing
 * parsers (`*.config.ts`, `mcp.config.ts`, `job-lessons.ts`, `project-mcp-tools.service.ts`); settings-validation.spec.ts
 * compares them with the parsers so they cannot drift.
 */
export const SETTING_FIELDS: Record<AgentId, SettingField[]> = {
    gilde: [
        { key: 'maxSteps', env: 'COPILOT_MAX_STEPS', label: 'Maximum steps per run', kind: 'int', min: 1, max: INT_MAX, default: DEFAULT_COPILOT_MAX_STEPS },
    ],
    verkenner: [
        { key: 'maxWakesPerDay', env: 'SCOUT_MAX_WAKES_PER_DAY', label: 'Wakes per project per day', kind: 'int', min: 1, max: INT_MAX, default: DEFAULT_SCOUT_MAX_WAKES_PER_DAY },
        { key: 'dailySuggestions', env: 'SCOUT_DAILY_SUGGESTIONS', label: 'Suggestions per project per day', kind: 'int', min: 1, max: INT_MAX, default: DEFAULT_SCOUT_DAILY_SUGGESTIONS },
        { key: 'summaryHourUtc', env: 'SCOUT_SUMMARY_HOUR_UTC', label: 'Daily summary hour (UTC)', kind: 'int', min: 0, max: 23, default: DEFAULT_SCOUT_SUMMARY_HOUR_UTC },
        { key: 'patternMinSize', env: 'SCOUT_PATTERN_MIN_SIZE', label: 'Smallest lesson pattern', kind: 'int', min: LESSON_PATTERN_MIN_SIZE, max: 100, default: DEFAULT_SCOUT_PATTERN_MIN_SIZE },
    ],
    verfijner: [
        { key: 'dailyLimit', env: 'REFINE_DAILY_LIMIT', label: 'Runs per project per day', kind: 'int', min: 1, max: INT_MAX, default: DEFAULT_REFINE_DAILY_LIMIT },
    ],
    werkmeester: [
        { key: 'dailyLimit', env: 'PLAN_DAILY_LIMIT', label: 'Runs per project per day', kind: 'int', min: 1, max: INT_MAX, default: DEFAULT_PLAN_DAILY_LIMIT },
    ],
    mcp: [
        { key: 'dailyJobLimit', env: 'MCP_DAILY_JOB_LIMIT', label: 'Jobs per user per day', kind: 'int', min: 0, max: INT_MAX, default: DEFAULT_MCP_DAILY_JOB_LIMIT },
        { key: 'dailyFeatureLimit', env: 'MCP_DAILY_FEATURE_LIMIT', label: 'Features per user per day', kind: 'int', min: 0, max: INT_MAX, default: DEFAULT_MCP_DAILY_FEATURE_LIMIT },
        { key: 'toolTimeoutMs', env: 'MCP_TOOL_TIMEOUT_MS', label: 'Project MCP tool timeout (ms)', kind: 'int', min: 1, max: 60_000, default: 5_000 },
        { key: 'toolResultMaxChars', env: 'MCP_TOOL_RESULT_MAX_CHARS', label: 'Project MCP tool result limit (characters)', kind: 'int', min: 1, max: 100_000, default: 8_000 },
    ],
    coding: [
        { key: 'lessonsTopK', env: 'DISPATCH_LESSONS_TOP_K', label: 'Lessons per job', kind: 'int', min: 0, max: LESSONS_MAX_COUNT, default: LESSONS_MAX_COUNT },
        { key: 'lessonsMinScore', env: 'DISPATCH_LESSONS_MIN_SCORE', label: 'Minimum lesson relevance (0 to 1)', kind: 'number', min: 0, max: 1, default: 0.5 },
        { key: 'lessonsTimeoutMs', env: 'DISPATCH_LESSONS_TIMEOUT_MS', label: 'Lesson lookup timeout (ms)', kind: 'int', min: 100, max: INT_MAX, default: 3_000 },
    ],
};

export type AgentSettingsValues = Record<string, number>;

export function defaultSettings(agent: AgentId): AgentSettingsValues {
    return Object.fromEntries(SETTING_FIELDS[agent].map((f) => [f.key, f.default]));
}

/** An error message for one value, or null when it is valid. */
export function checkValue(field: SettingField, value: unknown): string | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Must be a number';
    if (field.kind === 'int' && !Number.isSafeInteger(value)) return 'Must be a whole number';
    if (value < field.min) return `Must be at least ${field.min}`;
    if (value > field.max) return `Must be at most ${field.max}`;
    return null;
}

export interface SettingsIssue { path: string; message: string }

/** Full-replacement validation: every field present, nothing else, each within range. */
export function validateSettings(agent: AgentId, input: unknown): { values: AgentSettingsValues; issues: SettingsIssue[] } {
    const issues: SettingsIssue[] = [];
    const fields = SETTING_FIELDS[agent];
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { values: defaultSettings(agent), issues: [{ path: 'settings', message: 'Must be an object' }] };
    }
    const record = input as Record<string, unknown>;
    const values: AgentSettingsValues = {};
    for (const field of fields) {
        const value = record[field.key];
        if (value === undefined) issues.push({ path: `settings.${field.key}`, message: 'Required' });
        else {
            const problem = checkValue(field, value);
            if (problem) issues.push({ path: `settings.${field.key}`, message: problem });
            else values[field.key] = value as number;
        }
    }
    for (const key of Object.keys(record)) {
        if (!fields.some((f) => f.key === key)) issues.push({ path: `settings.${key}`, message: 'Unknown setting' });
    }
    return { values, issues };
}

export function isValidModel(model: string): boolean {
    return model.startsWith(COPILOT_MODEL_PREFIX) && model.length > COPILOT_MODEL_PREFIX.length;
}

const INTEGER_TEXT = /^\d+$/;

/** One environment value for seeding: blank is the default; present but out of range is `invalid`. */
export function seedValue(field: SettingField, raw: string | undefined): { value: number; invalid: boolean } {
    const text = raw?.trim();
    if (!text) return { value: field.default, invalid: false };
    const value = field.kind === 'int' ? (INTEGER_TEXT.test(text) ? Number(text) : NaN) : Number(text);
    return checkValue(field, value) === null ? { value, invalid: false } : { value: field.default, invalid: true };
}

/** The settings as the environment variables the existing parsers read; they then do the final judgement. */
export function settingsToEnv(agent: AgentId, values: AgentSettingsValues): Record<string, string> {
    return Object.fromEntries(SETTING_FIELDS[agent].map((f) => [f.env, String(values[f.key] ?? f.default)]));
}
