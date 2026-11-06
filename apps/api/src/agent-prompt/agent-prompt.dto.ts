import { z } from 'zod';

export const PromptFileSchema = z.object({
    /** Path in the repository. */
    path: z.string(),
    /** Link to the file on GitHub at `ref`; null when the loaded file is not a file of the repository. */
    url: z.string().nullable(),
    /** The commit the link points at, or the branch when the build's commit is unknown. */
    ref: z.string(),
    refKind: z.enum(['commit', 'branch']),
    /** How `ref` was obtained, in words. */
    refSource: z.string(),
});

export const PromptTextSchema = z.object({
    label: z.string(),
    text: z.string(),
    /** First 12 hex characters of the SHA-256 of the text. */
    version: z.string(),
    length: z.number().int(),
});

export const CodingPromptSchema = z.object({
    /** Value of AGENT_INSTRUCTIONS_PATH, null when it is not set. */
    instructionsPath: z.string().nullable(),
    /** Why the file cannot be loaded; null when it is loaded or not configured. */
    loadError: z.string().nullable(),
    limit: z.number().int(),
    layout: z.array(z.string()),
    payloadKeys: z.array(z.string()),
    limits: z.array(z.string()),
    trimmingOrder: z.array(z.string()),
});

/** The project's additional instructions as they are part of `instructions.text`: the block is its last part. */
export const PromptAdditionSchema = z.object({
    projectId: z.string().uuid(),
    projectName: z.string(),
    version: z.number().int(),
    /** The text an admin wrote. */
    text: z.string(),
    /** The delimited block (heading, precedence sentence and text) as appended to the base instructions. */
    block: z.string(),
});

export const AgentPromptSchema = z.object({
    agent: z.string(),
    /** `instructions`: the agent's instructions; `none`: the agent has no prompt of its own. */
    kind: z.enum(['instructions', 'none']),
    /** What the example binding is; null when the prompt has no dynamic parts. */
    exampleBinding: z.string().nullable(),
    /** The instructions exactly as the agent receives them (the file as loaded for coding agents). */
    instructions: PromptTextSchema.nullable(),
    /** The user message of a run, built with the example binding, for the agents that get one. */
    runPrompt: PromptTextSchema.nullable(),
    file: PromptFileSchema.nullable(),
    /** The settings the runs use now, for reference. */
    settings: z.record(z.string(), z.number()),
    coding: CodingPromptSchema.nullable(),
    /** The addition of the selected project that is part of the instructions; null when there is none or no project was selected. */
    addition: PromptAdditionSchema.nullable(),
    note: z.string().nullable(),
});
export type AgentPromptDto = z.infer<typeof AgentPromptSchema>;

export const PromptQuerySchema = z.object({ projectId: z.string().uuid().optional() });
export type PromptQuery = z.infer<typeof PromptQuerySchema>;
