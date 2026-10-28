import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { McpController } from './mcp.controller.js';
import { McpModule } from './mcp.module.js';

const DIR = import.meta.dirname;

describe('McpModule.register', () => {
    it('registers no route at all while MCP is off, so the path is a plain 404 before any guard', () => {
        expect(McpModule.register({}).controllers).toEqual([]);
        expect(McpModule.register({ MCP_ENABLED: 'false' }).controllers).toEqual([]);
        expect(McpModule.register({ MCP_ENABLED: 'TRUE' }).controllers).toEqual([]);
    });

    it('registers the controller only for the literal true', () => {
        expect(McpModule.register({ MCP_ENABLED: 'true' }).controllers).toEqual([McpController]);
    });

    it('fails startup on an invalid daily limit, enabled or not', () => {
        expect(() => McpModule.register({ MCP_ENABLED: 'true', MCP_DAILY_JOB_LIMIT: '' })).toThrow();
        expect(() => McpModule.register({ MCP_DAILY_FEATURE_LIMIT: '-1' })).toThrow();
    });

    it('never opens the endpoint with @Public() or its own auth bypass', () => {
        const sources = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
        for (const file of sources) {
            const text = readFileSync(join(DIR, file), 'utf8');
            expect(text, file).not.toMatch(/@Public\(|public\.decorator|IS_PUBLIC_KEY|AUTH_ENABLED|authEnabled/);
        }
    });
});
