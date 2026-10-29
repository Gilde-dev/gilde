import { z } from 'zod';

/** An MCP server that put snippets in a run's prompt: how many, and how many characters of text (without delimiters). */
export const RunKnowledgeSchema = z.object({
    server: z.string(),
    snippets: z.number().int(),
    chars: z.number().int(),
});
export type RunKnowledge = z.infer<typeof RunKnowledgeSchema>;
