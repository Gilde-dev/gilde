import { z } from 'zod';

/** The MCP endpoint writes its protocol response itself (JSON-RPC over Streamable HTTP); there is no Gilde DTO body. */
export const McpHandledSchema = z.void();

export type McpHandledDto = z.infer<typeof McpHandledSchema>;
