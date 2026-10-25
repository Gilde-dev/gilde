import { ExecutionError } from './execution.error.js';
import type { AgentInstructions } from './agent-instructions.service.js';
import type { JobPayload } from './execution.port.js';

/** Longest text sent to a routine, in characters. */
export const PROMPT_LIMIT = 60_000;

export interface JobPrompt {
    text: string;
    instructionsVersion: string | null;
}

/**
 * The exact text a fire sends: instructions, a `---` line, then the job line and JSON payload. Lessons are optional
 * context: when the prompt is too long they are dropped from the least relevant end until it fits. Instructions, task
 * and criteria are never shortened; if they alone are too long that is a config error, as before.
 */
export function buildJobPrompt(payload: JobPayload, instructions: AgentInstructions): JobPrompt {
    const render = (p: JobPayload) => {
        const job =
            `Gilde job ${p.jobId} (attempt ${p.attempt}). Execute it as described in your routine instructions.\n\n` +
            JSON.stringify(p);
        return instructions.text === null ? job : `${instructions.text.trimEnd()}\n\n---\n\n${job}`;
    };
    let { lessons, ...rest } = payload;
    let text = render(payload);
    while (text.length > PROMPT_LIMIT && lessons?.length) {
        lessons = lessons.slice(0, -1);
        text = render(lessons.length ? { ...rest, lessons } : rest);
    }
    if (text.length > PROMPT_LIMIT) {
        throw new ExecutionError(
            `Prompt for job ${payload.jobId} is ${text.length} characters, over the ${PROMPT_LIMIT} limit; shorten the agent instructions or the job`,
            'config',
        );
    }
    return { text, instructionsVersion: instructions.version };
}
