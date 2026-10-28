interface Message { role: string; content: unknown }

export type ScriptedStep = { tool: string; input: unknown } | { text: string };

/**
 * Deterministic AI SDK model for tests: each model call plays the next scripted step (a tool call or a text answer) and,
 * once the script is over, answers with text. Records the prompts it was given. No network.
 */
export function scriptedModel(steps: ScriptedStep[]) {
    const prompts: Message[][] = [];
    let call = 0;
    const model = {
        specificationVersion: 'v2' as const, provider: 'stub', modelId: 'stub', supportedUrls: {},
        doGenerate: async () => { throw new Error('stub model only streams'); },
        doStream: async (options: { prompt: Message[] }) => {
            prompts.push(options.prompt);
            const step = steps[call++] ?? { text: 'done' };
            const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
            return {
                stream: new ReadableStream({
                    start(controller) {
                        controller.enqueue({ type: 'stream-start', warnings: [] });
                        if ('tool' in step) {
                            controller.enqueue({ type: 'tool-call', toolCallId: `call-${call}`, toolName: step.tool, input: JSON.stringify(step.input) });
                            controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
                        } else {
                            controller.enqueue({ type: 'text-start', id: 't' });
                            controller.enqueue({ type: 'text-delta', id: 't', delta: step.text });
                            controller.enqueue({ type: 'text-end', id: 't' });
                            controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
                        }
                        controller.close();
                    },
                }),
            };
        },
    };
    return { model, prompts };
}

/** A body that passes the spec parser, with the issue URL in Context. */
export function validSpecBody(url: string, extra = ''): string {
    return `## Goal\n\nExport data as CSV.\n\n## Context\n\nFrom ${url}.\n\n## Behaviour\n\nA download button exports the list.\n\n## Acceptance criteria\n\n- AC-1: The export downloads a CSV file with a header row.\n${extra}\n## Out of scope\n\nOther formats.\n\n## Open questions\n\nNone\n`;
}
