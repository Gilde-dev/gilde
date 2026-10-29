import { agentLogMaxChars, agentLogRetentionDays } from './agent-run.config.js';

describe('agent log config', () => {
    it('defaults to 2000 characters and 90 days', () => {
        expect(agentLogMaxChars({})).toBe(2000);
        expect(agentLogRetentionDays({})).toBe(90);
        expect(agentLogRetentionDays({ AGENT_LOG_RETENTION_DAYS: '  ' })).toBe(90);
    });

    it('reads valid values', () => {
        expect(agentLogMaxChars({ AGENT_LOG_MAX_CHARS: '500' })).toBe(500);
        expect(agentLogRetentionDays({ AGENT_LOG_RETENTION_DAYS: '7' })).toBe(7);
    });

    it('rejects invalid values with the variable name', () => {
        for (const value of ['0', '-1', '1.5', 'abc', '99999']) {
            expect(() => agentLogRetentionDays({ AGENT_LOG_RETENTION_DAYS: value })).toThrow('AGENT_LOG_RETENTION_DAYS');
        }
        expect(() => agentLogMaxChars({ AGENT_LOG_MAX_CHARS: '5' })).toThrow('AGENT_LOG_MAX_CHARS');
    });
});
