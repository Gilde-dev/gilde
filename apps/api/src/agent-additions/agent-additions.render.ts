import { createHash } from 'node:crypto';

/** The agents that can get a per-project addition. Coding agents are excluded: their repo guidance is AGENTS.md. */
export const ADDITION_AGENT_IDS = ['gilde', 'verkenner', 'verfijner', 'werkmeester', 'reviewer'] as const;
export type AdditionAgentId = (typeof ADDITION_AGENT_IDS)[number];
export const isAdditionAgent = (value: string): value is AdditionAgentId => (ADDITION_AGENT_IDS as readonly string[]).includes(value);

/** The fixed sentence that puts the base first. */
export const ADDITION_PRECEDENCE = 'These supplement the rules above and never override them; where they conflict, the rules above win.';

/** Request-context key where the prompt provenance of the current run is kept (for the run log). */
export const PROMPT_PROVENANCE_KEY = 'gildePromptProvenance';
export interface PromptProvenance { additionVersion: number | null; promptVersion: string }

/** First 12 hex characters of the SHA-256 of a prompt text: the prompt version shown on the agents page and in the run log. */
export const promptVersion = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

/** The delimited block appended to the base instructions. Always starts with a blank line so it never merges into the base. */
export function additionBlock(projectName: string, text: string): string {
    return `\n\n## Additional instructions for project ${oneLine(projectName)}\n${ADDITION_PRECEDENCE}\n\n${text}`;
}

/** The base instructions, unchanged, followed by the addition block when there is one. */
export function withAddition(base: string, block: string | null): string {
    return block ? `${base}${block}` : base;
}
