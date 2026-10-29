import { isIP } from 'node:net';

import { z } from 'zod';

import { PROJECT_MCP_AUDIT_ACTIONS } from './project-mcp-audit.entity.js';
import { PROJECT_MCP_TOOL_MODES } from './project-mcp-tool.entity.js';

export const MAX_PROJECT_MCP_TOOLS = 200;
export const PROJECT_MCP_AUDIT_LIMIT = 100;

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

function isInternalHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
    const family = isIP(host);
    if (family === 4) return PRIVATE_V4.some((re) => re.test(host));
    if (family === 6) return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:');
    return false;
}

/** https only, no credentials or fragment, and not an obviously internal host (the API host must not become a proxy into its network). */
export const McpServerUrlSchema = z.string().trim().max(500).refine((value) => {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !isInternalHost(url.hostname);
}, { message: 'Must be a public https URL without credentials or fragment' });

/** Opaque bearer token: printable, no whitespace. Never echoed in a validation message. */
export const McpTokenSchema = z.string().trim().min(1).max(1000).regex(/^[\x21-\x7e]+$/, { message: 'Must not contain spaces or control characters' });

const NameSchema = z.string().trim().min(1).max(80);

export const CreateProjectMcpServerSchema = z.object({
    name: NameSchema,
    url: McpServerUrlSchema,
    token: McpTokenSchema.optional(),
    enabled: z.boolean().optional(),
    unattendedEnabled: z.boolean().optional(),
});
export type CreateProjectMcpServerDto = z.infer<typeof CreateProjectMcpServerSchema>;

/** Full replacement of the updatable fields; the token is replaced through its own route. */
export const ReplaceProjectMcpServerSchema = z.object({
    name: NameSchema,
    url: McpServerUrlSchema,
    enabled: z.boolean(),
    unattendedEnabled: z.boolean(),
});
export type ReplaceProjectMcpServerDto = z.infer<typeof ReplaceProjectMcpServerSchema>;

export const ReplaceProjectMcpTokenSchema = z.object({
    token: McpTokenSchema,
});
export type ReplaceProjectMcpTokenDto = z.infer<typeof ReplaceProjectMcpTokenSchema>;

/** Replaces the allowlist: every listed tool gets the given mode and allowed flag, tools not listed become not allowed. */
export const ReplaceProjectMcpToolsSchema = z.object({
    tools: z.array(z.object({
        name: z.string().min(1).max(200),
        mode: z.enum(PROJECT_MCP_TOOL_MODES),
        allowed: z.boolean(),
    })).max(MAX_PROJECT_MCP_TOOLS),
});
export type ReplaceProjectMcpToolsDto = z.infer<typeof ReplaceProjectMcpToolsSchema>;

/** Never carries the token, its ciphertext, IV or tag. */
export const ProjectMcpServerResponseSchema = z.object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    url: z.string(),
    hasToken: z.boolean(),
    tokenLast4: z.string().nullable(),
    enabled: z.boolean(),
    unattendedEnabled: z.boolean(),
    lastTestedAt: z.string().nullable(),
    lastError: z.string().nullable(),
    lastErrorAt: z.string().nullable(),
    callCount: z.number().int(),
    errorCount: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type ProjectMcpServerResponseDto = z.infer<typeof ProjectMcpServerResponseSchema>;

export const ProjectMcpToolResponseSchema = z.object({
    name: z.string(),
    description: z.string(),
    mode: z.enum(PROJECT_MCP_TOOL_MODES),
    allowed: z.boolean(),
});
export type ProjectMcpToolResponseDto = z.infer<typeof ProjectMcpToolResponseSchema>;

export const ProjectMcpAuditResponseSchema = z.object({
    id: z.string(),
    serverId: z.string(),
    serverName: z.string(),
    actorId: z.string(),
    actorEmail: z.string(),
    action: z.enum(PROJECT_MCP_AUDIT_ACTIONS),
    changes: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
});
export type ProjectMcpAuditResponseDto = z.infer<typeof ProjectMcpAuditResponseSchema>;

export const ProjectMcpServerDetailResponseSchema = ProjectMcpServerResponseSchema.extend({
    tools: z.array(ProjectMcpToolResponseSchema),
    audit: z.array(ProjectMcpAuditResponseSchema),
});
export type ProjectMcpServerDetailResponseDto = z.infer<typeof ProjectMcpServerDetailResponseSchema>;

export const MCP_TEST_ERROR_KINDS = ['unreachable', 'timeout', 'auth', 'not_mcp'] as const;
export type McpTestErrorKind = (typeof MCP_TEST_ERROR_KINDS)[number];

/** A failed test is a normal answer (200 with `ok: false`), so the UI can show the reason next to the server. */
export const ProjectMcpTestResponseSchema = z.object({
    ok: z.boolean(),
    errorKind: z.enum(MCP_TEST_ERROR_KINDS).nullable(),
    message: z.string().nullable(),
    tools: z.array(ProjectMcpToolResponseSchema),
});
export type ProjectMcpTestResponseDto = z.infer<typeof ProjectMcpTestResponseSchema>;
