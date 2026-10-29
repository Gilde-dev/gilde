import { describe, expect, it } from 'vitest';

import { copilotConfig } from '../copilot/copilot.config.js';
import { lessonRetrievalOptions } from '../execution/job-lessons.js';
import { mcpConfig } from '../mcp/mcp.config.js';
import { mcpToolLimits } from '../project-mcp/project-mcp-tools.service.js';
import { refineConfig } from '../copilot/verfijner.config.js';
import { scoutConfig } from '../copilot/verkenner.config.js';
import { planConfig } from '../copilot/werkmeester.config.js';

import { agentsDisabled } from './agents-disabled.js';
import { AGENT_IDS, type AgentId } from './agent-ids.js';
import { defaultSettings, SETTING_FIELDS, seedValue, settingsToEnv, validateSettings } from './agent-settings.js';

const KEY = { OPENAI_API_KEY: 'sk-test' };

/** Whether the existing parser of the agent accepts this value of one setting (everything else valid). */
function parserAccepts(agent: AgentId, key: string, value: number): boolean {
    const values = { ...defaultSettings(agent), [key]: value };
    const env = settingsToEnv(agent, values);
    switch (agent) {
        case 'verkenner':
            return scoutConfig({ ...KEY, ...env, SCOUT_ENABLED: 'true', SCOUT_USER_EMAIL: 'bot@example.com', SCOUT_MODEL: 'openai/m' }).enabled;
        case 'verfijner':
            return refineConfig({ ...KEY, ...env, REFINE_ENABLED: 'true', REFINE_USER_EMAIL: 'bot@example.com', REFINE_MODEL: 'openai/m' }).enabled;
        case 'werkmeester':
            return planConfig({ ...KEY, ...env, PLAN_ENABLED: 'true', PLAN_USER_EMAIL: 'bot@example.com', PLAN_MODEL: 'openai/m' }).enabled;
        case 'mcp': {
            try { mcpConfig({ ...env, MCP_ENABLED: 'true' }); } catch { return false; }
            // The tool limits fall back to their default instead of failing: accepted iff the value survives unchanged.
            const limits = mcpToolLimits(env);
            return key === 'toolTimeoutMs' ? limits.timeoutMs === value : key === 'toolResultMaxChars' ? limits.maxResultChars === value : true;
        }
        case 'coding': {
            const o = lessonRetrievalOptions(env);
            return key === 'lessonsTopK' ? o.topK === value : key === 'lessonsMinScore' ? o.minScore === value : o.timeoutMs === value;
        }
        case 'gilde':
            return Number(copilotConfig({ ...KEY, COPILOT_MODEL: 'openai/m', ...env }).enabled && (copilotConfig({ ...KEY, COPILOT_MODEL: 'openai/m', ...env }) as { maxSteps: number }).maxSteps) === value;
    }
}

describe('agent settings validate like the existing parsers', () => {
    for (const agent of AGENT_IDS) {
        for (const field of SETTING_FIELDS[agent]) {
            const candidates = field.kind === 'number'
                ? [field.min, field.max, field.default, field.min - 0.1, field.max + 0.1]
                : [field.min, field.max === Number.MAX_SAFE_INTEGER ? 1_000_000 : field.max, field.default, field.min - 1].concat(field.max === Number.MAX_SAFE_INTEGER ? [] : [field.max + 1]);
            it(`${agent}.${field.key}: ${candidates.join(', ')}`, () => {
                for (const value of candidates) {
                    const mine = validateSettings(agent, { ...defaultSettings(agent), [field.key]: value }).issues.length === 0;
                    expect(mine, `value ${value}`).toBe(parserAccepts(agent, field.key, value));
                }
            });
        }
    }

    it('defaults equal the parsers\' defaults when nothing is set', () => {
        expect(scoutConfig({ ...KEY, SCOUT_ENABLED: 'true', SCOUT_USER_EMAIL: 'b@example.com', SCOUT_MODEL: 'openai/m' })).toMatchObject(defaultSettings('verkenner'));
        expect(refineConfig({ ...KEY, REFINE_ENABLED: 'true', REFINE_USER_EMAIL: 'b@example.com', REFINE_MODEL: 'openai/m' })).toMatchObject(defaultSettings('verfijner'));
        expect(planConfig({ ...KEY, PLAN_ENABLED: 'true', PLAN_USER_EMAIL: 'b@example.com', PLAN_MODEL: 'openai/m' })).toMatchObject(defaultSettings('werkmeester'));
        const mcp = mcpConfig({});
        expect(defaultSettings('mcp')).toMatchObject({ dailyJobLimit: mcp.dailyJobLimit, dailyFeatureLimit: mcp.dailyFeatureLimit });
        const limits = mcpToolLimits({});
        expect(defaultSettings('mcp')).toMatchObject({ toolTimeoutMs: limits.timeoutMs, toolResultMaxChars: limits.maxResultChars });
        const lessons = lessonRetrievalOptions({});
        expect(defaultSettings('coding')).toEqual({ lessonsTopK: lessons.topK, lessonsMinScore: lessons.minScore, lessonsTimeoutMs: lessons.timeoutMs });
        expect(defaultSettings('gilde')).toEqual({ maxSteps: (copilotConfig({ ...KEY, COPILOT_MODEL: 'openai/m' }) as { maxSteps: number }).maxSteps });
    });
});

describe('validateSettings', () => {
    it('requires every field, rejects unknown ones and non-numbers, and names the field', () => {
        const { issues } = validateSettings('verfijner', { other: 1 });
        expect(issues).toEqual(expect.arrayContaining([{ path: 'settings.dailyLimit', message: 'Required' }, { path: 'settings.other', message: 'Unknown setting' }]));
        expect(validateSettings('verfijner', { dailyLimit: '5' }).issues[0]).toEqual({ path: 'settings.dailyLimit', message: 'Must be a number' });
        expect(validateSettings('verfijner', null).issues[0]!.path).toBe('settings');
        expect(validateSettings('verfijner', { dailyLimit: 2.5 }).issues[0]!.message).toBe('Must be a whole number');
    });
});

describe('seedValue', () => {
    const field = SETTING_FIELDS.verfijner[0]!;
    it('takes the default for a blank value, the value when valid and flags an invalid one', () => {
        expect(seedValue(field, undefined)).toEqual({ value: 10, invalid: false });
        expect(seedValue(field, ' 7 ')).toEqual({ value: 7, invalid: false });
        expect(seedValue(field, '0')).toEqual({ value: 10, invalid: true });
        expect(seedValue(field, 'x')).toEqual({ value: 10, invalid: true });
        expect(seedValue(field, '1e3')).toEqual({ value: 10, invalid: true });
    });
});

describe('AGENTS_DISABLED', () => {
    it('is empty when unset, names agents, or all', () => {
        expect([...agentsDisabled({})]).toEqual([]);
        expect([...agentsDisabled({ AGENTS_DISABLED: ' verkenner, Werkmeester ' })]).toEqual(['verkenner', 'werkmeester']);
        expect(agentsDisabled({ AGENTS_DISABLED: 'all' }).size).toBe(AGENT_IDS.length);
        expect(agentsDisabled({ AGENTS_DISABLED: 'gilde,all' }).size).toBe(AGENT_IDS.length);
    });

    it('fails closed on an unknown id', () => {
        expect(() => agentsDisabled({ AGENTS_DISABLED: 'verkenner,scoot' })).toThrow('scoot');
    });
});
