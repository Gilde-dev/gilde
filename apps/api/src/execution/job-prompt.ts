import { taskContentSize } from '../job/task-size.js';
import { DOWNSTREAM_LIMIT, DOWNSTREAM_TASK_LIMIT } from './downstream.js';
import { FEATURE_SPEC_LIMIT } from './job-payload.js';
import { ExecutionError } from './execution.error.js';
import type { AgentInstructions } from './agent-instructions.service.js';
import { JobPayloadSchema, type JobPayload, type PreparedPrompt, type PromptContext, type PromptTrimmed } from './execution.port.js';

/** Longest text sent to a routine, in characters. */
export const PROMPT_LIMIT = 60_000;

/** Added to a downstream task that was cut to fit its cap; the cap includes it. */
export const TRUNCATED_SUFFIX = '… (truncated; read the full job with its id if needed)';

/** Downstream task caps tried in order, then the task keys are left out. */
const TASK_CAPS = [1500, 400] as const;
/** Feature spec caps tried last, in order. */
const SPEC_CAPS = [4000, 2000] as const;

type DownstreamEntry = NonNullable<JobPayload['downstream']>[number];

interface Reduction {
    knowledge: number;
    lessons: number;
    taskCap: number | 'title-only' | null;
    removed: Set<string>;
    specCap: number | null;
}

function capTask(d: DownstreamEntry, cap: number | 'title-only' | null): DownstreamEntry {
    if (cap === null || d.task === undefined) return d;
    if (cap === 'title-only') {
        const { task: _task, ...rest } = d;
        return rest;
    }
    return d.task.length > cap ? { ...d, task: d.task.slice(0, cap - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX } : d;
}

/**
 * The exact text a fire sends: instructions, a `---` line, then the job line and JSON payload. Optional context is
 * reduced while the text is over PROMPT_LIMIT, one step at a time and re-rendered (including `promptTrimmed`) after each,
 * stopping as soon as it fits: knowledge snippets from the lowest ranked end; lessons from the least relevant end; downstream tasks capped at 1500, then 400, then left
 * out; downstream jobs removed (oldest unrelated feature siblings first, then dependents, oldest first); the feature spec
 * capped at 4000, then 2000. Instructions, the job's own task and criteria are never shortened. Never mutates `payload`;
 * a result that still does not fit is returned with `fits: false`.
 */
export function prepareJobPrompt(payload: JobPayload, instructions: AgentInstructions, context: PromptContext = {}): PreparedPrompt {
    const lessons = payload.lessons ?? [];
    const downstream = payload.downstream ?? [];
    const initial = context.initial ?? {};
    const dependents = context.dependents ?? new Set<string>();
    const knowledge = payload.knowledge?.snippets ?? [];
    const state: Reduction = { knowledge: knowledge.length, lessons: lessons.length, taskCap: null, removed: new Set(), specCap: null };

    const view = (): { payload: JobPayload; trimmed: PromptTrimmed | null } => {
        const keptLessons = lessons.slice(0, state.lessons);
        const keptDownstream = downstream.filter((d) => !state.removed.has(d.jobId)).map((d) => capTask(d, state.taskCap));
        const trimmed: PromptTrimmed = {};
        const keptKnowledge = knowledge.slice(0, state.knowledge);
        if (keptKnowledge.length < knowledge.length) trimmed.knowledgeRemoved = knowledge.length - keptKnowledge.length;
        if (keptLessons.length < lessons.length) trimmed.lessonsRemoved = lessons.slice(state.lessons).map((l) => l.id);
        if (state.taskCap === 'title-only') trimmed.downstreamTaskCap = 'title-only';
        else if (state.taskCap !== null && downstream.some((d) => !state.removed.has(d.jobId) && (d.task?.length ?? 0) > (state.taskCap as number))) trimmed.downstreamTaskCap = state.taskCap;
        else if (initial.downstreamTaskCap) trimmed.downstreamTaskCap = initial.downstreamTaskCap;
        if (initial.downstreamOmitted) trimmed.downstreamOmitted = initial.downstreamOmitted;
        if (state.removed.size) trimmed.downstreamRemoved = downstream.filter((d) => state.removed.has(d.jobId)).map((d) => d.jobId);

        let feature = payload.feature;
        if (feature && state.specCap !== null && feature.spec.length > state.specCap) {
            feature = { ...feature, spec: feature.spec.slice(0, state.specCap) };
            trimmed.featureSpecCap = state.specCap;
        } else if (initial.featureSpecCap) {
            trimmed.featureSpecCap = initial.featureSpecCap;
        }

        // Keep the payload's own key order so an untrimmed prompt is byte-for-byte what it always was.
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(payload)) {
            if (key === 'promptTrimmed') continue;
            if (key === 'lessons') { if (keptLessons.length) out[key] = keptLessons; }
            else if (key === 'knowledge') { if (keptKnowledge.length) out[key] = { ...payload.knowledge, snippets: keptKnowledge }; }
            else if (key === 'downstream') { if (keptDownstream.length) out[key] = keptDownstream; }
            else if (key === 'feature') out[key] = feature;
            else out[key] = value;
        }
        const final = Object.keys(trimmed).length ? trimmed : null;
        if (final) out.promptTrimmed = final;
        return { payload: out as JobPayload, trimmed: final };
    };

    const render = (p: JobPayload) => {
        const job =
            `Gilde job ${p.jobId} (attempt ${p.attempt}). Execute it as described in your routine instructions.\n\n` +
            JSON.stringify(p);
        return instructions.text === null ? job : `${instructions.text.trimEnd()}\n\n---\n\n${job}`;
    };

    // Removal order: unrelated feature siblings first, then dependents, each oldest first (the list is oldest first).
    const removalOrder = [
        ...downstream.filter((d) => !dependents.has(d.jobId)),
        ...downstream.filter((d) => dependents.has(d.jobId)),
    ].map((d) => d.jobId);
    const steps: (() => void)[] = [
        // External reference text goes first: the job's own task and criteria are never shortened.
        ...knowledge.map(() => () => { state.knowledge--; }),
        ...lessons.map(() => () => { state.lessons--; }),
        ...(downstream.length ? [...TASK_CAPS.map((cap) => () => { state.taskCap = cap; }), () => { state.taskCap = 'title-only' as const; }] : []),
        ...removalOrder.map((id) => () => { state.removed.add(id); }),
        ...(payload.feature ? SPEC_CAPS.map((cap) => () => { state.specCap = cap; }) : []),
    ];

    let current = view();
    let text = render(current.payload);
    for (const step of steps) {
        if (text.length <= PROMPT_LIMIT) break;
        step();
        current = view();
        text = render(current.payload);
    }
    return {
        prepared: true,
        payload: current.payload,
        text,
        length: text.length,
        limit: PROMPT_LIMIT,
        fits: text.length <= PROMPT_LIMIT,
        instructionsVersion: instructions.version,
        instructionsLength: instructions.text === null ? 0 : instructions.text.trimEnd().length,
        ownLength: taskContentSize(payload.task, payload.acceptanceCriteria),
        trimmed: current.trimmed,
    };
}

const spaced = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ').replace(/ /g, ' ');

/** The job-scoped error for a prompt that does not fit after trimming. */
export function promptTooLargeError(prompt: PreparedPrompt, jobId: string): ExecutionError {
    const own = `the task and criteria alone are ${spaced(prompt.ownLength)}`;
    const instructionsExplain = prompt.instructionsLength > 0 && prompt.length - prompt.instructionsLength <= prompt.limit;
    const instructions = instructionsExplain ? `, the agent instructions take ${spaced(prompt.instructionsLength)}` : '';
    return new ExecutionError(
        `Prompt for job ${jobId} is ${spaced(prompt.length)} characters after trimming, over the ${spaced(prompt.limit)} limit; ${own}${instructions}: shorten the task or its acceptance criteria`,
        'prompt_too_large',
    );
}

/** The assembly of a coding agent's prompt, for display: derived from the constants and rules of this file, not written out again. */
export function describePromptAssembly(): { limit: number; layout: string[]; payloadKeys: string[]; limits: string[]; trimmingOrder: string[] } {
    return {
        limit: PROMPT_LIMIT,
        layout: [
            'The agent instructions file (AGENT_INSTRUCTIONS_PATH), trailing whitespace removed',
            'A line with ---',
            'The line "Gilde job <jobId> (attempt <n>). Execute it as described in your routine instructions."',
            'The job payload as one line of JSON',
        ],
        payloadKeys: Object.keys(JobPayloadSchema.shape),
        limits: [
            `The whole text is at most ${PROMPT_LIMIT} characters`,
            `The feature spec is cut to ${FEATURE_SPEC_LIMIT} characters when the payload is built`,
            `At most ${DOWNSTREAM_LIMIT} downstream jobs are listed, with tasks of at most ${DOWNSTREAM_TASK_LIMIT} characters`,
        ],
        trimmingOrder: [
            'Knowledge snippets from the project MCP servers, lowest ranked first',
            'Lessons, least relevant first',
            ...TASK_CAPS.map((cap) => `Tasks of downstream jobs cut to ${cap} characters`),
            'Tasks of downstream jobs left out (titles stay)',
            'Downstream jobs removed: unrelated feature siblings first, then dependents, each oldest first',
            ...SPEC_CAPS.map((cap) => `The feature spec cut to ${cap} characters`),
            'Never shortened: the instructions, and the job\'s own task and acceptance criteria. A prompt that still does not fit is not fired.',
        ],
    };
}
