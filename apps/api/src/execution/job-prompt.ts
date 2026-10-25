import { ExecutionError } from './execution.error.js';
import type { AgentInstructions } from './agent-instructions.service.js';
import type { JobPayload } from './execution.port.js';

/** Longest text sent to a routine, in characters. */
export const PROMPT_LIMIT = 60_000;

export interface JobPrompt {
    text: string;
    instructionsVersion: string | null;
}

/** The exact text a fire sends: instructions, a `---` line, then the job line and JSON payload. */
export function buildJobPrompt(payload: JobPayload, instructions: AgentInstructions): JobPrompt {
    const job =
        `Gilde job ${payload.jobId} (attempt ${payload.attempt}). Execute it as described in your routine instructions.\n\n` +
        JSON.stringify(payload);
    const text = instructions.text === null ? job : `${instructions.text.trimEnd()}\n\n---\n\n${job}`;
    if (text.length > PROMPT_LIMIT) {
        throw new ExecutionError(
            `Prompt for job ${payload.jobId} is ${text.length} characters, over the ${PROMPT_LIMIT} limit; shorten the agent instructions or the job`,
            'config',
        );
    }
    return { text, instructionsVersion: instructions.version };
}
