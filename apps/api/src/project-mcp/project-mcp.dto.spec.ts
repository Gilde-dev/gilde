import { randomBytes } from 'node:crypto';

import { ExecutorSecretService } from '../executor/executor-secret.service.js';

import { CreateProjectMcpServerSchema, McpServerUrlSchema, ProjectMcpServerResponseSchema, ReplaceProjectMcpServerSchema } from './project-mcp.dto.js';
import { PROJECT_MCP_KEY_VERSION } from './project-mcp-server.entity.js';

describe('project MCP DTOs', () => {
    it.each(['https://mcp.example.com/mcp', 'https://mcp.example.com:8443/a?b=1', 'https://8.8.8.8/mcp'])('accepts %s', (url) => {
        expect(McpServerUrlSchema.safeParse(url).success).toBe(true);
    });

    it.each([
        'http://mcp.example.com', 'https://u:p@mcp.example.com', 'https://mcp.example.com/#x', 'https://localhost', 'https://app.localhost',
        'https://db.internal', 'https://printer.local', 'https://127.0.0.1', 'https://10.1.2.3', 'https://172.16.0.1', 'https://192.168.1.1',
        'https://169.254.169.254', 'https://100.64.0.1', 'https://[::1]', 'https://[fd00::1]', 'https://[::ffff:127.0.0.1]', '', 'mcp.example.com',
    ])('rejects %s', (url) => {
        expect(McpServerUrlSchema.safeParse(url).success).toBe(false);
    });

    it('requires a full replacement and keeps the token out of it', () => {
        expect(ReplaceProjectMcpServerSchema.safeParse({ name: 'x', url: 'https://a.example.com' }).success).toBe(false);
        const parsed = ReplaceProjectMcpServerSchema.parse({ name: 'x', url: 'https://a.example.com', enabled: true, unattendedEnabled: false, token: 'secret' });
        expect(parsed).not.toHaveProperty('token');
    });

    it('does not echo the token in a validation message', () => {
        const result = CreateProjectMcpServerSchema.safeParse({ name: 'x', url: 'https://a.example.com', token: 'has secret space' });
        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error?.issues)).not.toContain('secret');
    });

    it('has no field for a token, ciphertext or key in the response schema', () => {
        expect(Object.keys(ProjectMcpServerResponseSchema.shape).filter((k) => /token|cipher|iv|tag|key/i.test(k))).toEqual(['hasToken', 'tokenLast4']);
    });
});

describe('project MCP token encryption scope', () => {
    const previous = process.env.EXECUTOR_SECRET_KEY;
    afterEach(() => {
        if (previous === undefined) delete process.env.EXECUTOR_SECRET_KEY;
        else process.env.EXECUTOR_SECRET_KEY = previous;
    });

    it('round-trips under its own key version and refuses a token of another scope', () => {
        process.env.EXECUTOR_SECRET_KEY = randomBytes(32).toString('base64');
        const secrets = new ExecutorSecretService();
        const encrypted = secrets.encrypt('mcp-token', PROJECT_MCP_KEY_VERSION + 1);
        expect(encrypted.keyVersion).toBe(PROJECT_MCP_KEY_VERSION + 1);
        expect(secrets.decrypt(encrypted, PROJECT_MCP_KEY_VERSION + 1)).toBe('mcp-token');
        expect(() => secrets.decrypt(encrypted, PROJECT_MCP_KEY_VERSION)).toThrow(/key version/);
    });
});
