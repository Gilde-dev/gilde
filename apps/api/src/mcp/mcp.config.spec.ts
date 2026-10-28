import { DEFAULT_MCP_DAILY_FEATURE_LIMIT, DEFAULT_MCP_DAILY_JOB_LIMIT, mcpConfig } from './mcp.config.js';

describe('mcpConfig', () => {
    it('is off with the documented defaults when nothing is set', () => {
        expect(mcpConfig({})).toEqual({ enabled: false, dailyJobLimit: 20, dailyFeatureLimit: 5 });
        expect(DEFAULT_MCP_DAILY_JOB_LIMIT).toBe(20);
        expect(DEFAULT_MCP_DAILY_FEATURE_LIMIT).toBe(5);
    });

    it.each([['TRUE'], ['1'], ['yes'], [' true'], ['true '], ['']])('stays off for MCP_ENABLED=%j', (value) => {
        expect(mcpConfig({ MCP_ENABLED: value }).enabled).toBe(false);
    });

    it('is on only for the literal true', () => {
        expect(mcpConfig({ MCP_ENABLED: 'true' }).enabled).toBe(true);
    });

    it('reads the limits, and zero is a valid limit that disables creation', () => {
        expect(mcpConfig({ MCP_DAILY_JOB_LIMIT: '7', MCP_DAILY_FEATURE_LIMIT: '0' })).toMatchObject({ dailyJobLimit: 7, dailyFeatureLimit: 0 });
        expect(mcpConfig({ MCP_DAILY_JOB_LIMIT: '0' }).dailyJobLimit).toBe(0);
    });

    it.each([[''], [' '], ['-1'], ['1.5'], ['abc'], ['Infinity'], ['NaN'], ['1e3'], ['9007199254740993'], ['99999999999999999999'], [' 5'], ['5 '], ['0x10']])('rejects %j instead of lifting the limit', (value) => {
        expect(() => mcpConfig({ MCP_DAILY_JOB_LIMIT: value })).toThrow(/MCP_DAILY_JOB_LIMIT must be a non-negative integer/);
        expect(() => mcpConfig({ MCP_DAILY_FEATURE_LIMIT: value })).toThrow(/MCP_DAILY_FEATURE_LIMIT must be a non-negative integer/);
    });

    it('does not echo the invalid value', () => {
        expect(() => mcpConfig({ MCP_DAILY_JOB_LIMIT: 'secret-ish' })).not.toThrow(/secret-ish/);
    });

    it('validates the limits also while MCP is off (fail closed at startup)', () => {
        expect(() => mcpConfig({ MCP_ENABLED: 'false', MCP_DAILY_JOB_LIMIT: '-3' })).toThrow();
    });
});
