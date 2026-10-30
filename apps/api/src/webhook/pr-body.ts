import { z } from 'zod';

export const OPERATOR_ACTION_KINDS = ['env', 'permission', 'cli', 'infra', 'manual'] as const;
export const OPERATOR_ACTION_WHEN = ['before_deploy', 'after_deploy'] as const;
export const MAX_OPERATOR_ACTIONS = 20;

/** Known token formats; operator actions describe how to get a value and never contain one. */
const SECRET_LOOKING = /(?<![A-Za-z0-9])(?:gk_[A-Za-z0-9]|sk-[A-Za-z0-9]|ghp_[A-Za-z0-9]|github_pat_|xox[a-z]?-?[A-Za-z0-9])|-----BEGIN [A-Z ]*-----/;
const noSecret = (value: string) => !SECRET_LOOKING.test(value);
const NO_SECRET = { message: 'looks like a secret; describe how to obtain the value instead' };

/** A manual step a PR needs outside the code. The format is a contract with the infra workflow that reads merged PR bodies. */
export const operatorActionSchema = z.object({
    kind: z.enum(OPERATOR_ACTION_KINDS),
    when: z.enum(OPERATOR_ACTION_WHEN),
    instruction: z.string().min(1).max(1000).refine(noSecret, NO_SECRET),
    /** E.g. the environment variable. */
    name: z.string().max(200).refine(noSecret, NO_SECRET).optional(),
    /** E.g. apiEnv, channelsEnv, GitHub App. */
    where: z.string().max(200).refine(noSecret, NO_SECRET).optional(),
    /** Read as true when omitted (see isRequiredAction). */
    required: z.boolean().optional(),
});

export type OperatorAction = z.infer<typeof operatorActionSchema>;

/** `required` is true unless the agent said false. */
export const isRequiredAction = (a: Pick<OperatorAction, 'required'>) => a.required !== false;

const gildeResultBaseSchema = z.object({
    outcome: z.enum(['done', 'partial', 'blocked']),
    summary: z.string(),
    testsRun: z.boolean().optional(),
    testsPassed: z.boolean().optional(),
    suggestedLesson: z.string().nullable().optional(),
});

export const gildeResultSchema = gildeResultBaseSchema.extend({
    operatorActions: z.array(operatorActionSchema).max(MAX_OPERATOR_ACTIONS).optional(),
});

export type GildeResult = z.infer<typeof gildeResultSchema>;

/** One proposed change to a job; omitted content fields mean unchanged. */
export const gildeProposalSchema = z.object({
    jobId: z.string().uuid(),
    title: z.string().trim().min(3).max(200).optional(),
    task: z.string().trim().min(10).optional(),
    acceptanceCriteria: z.array(z.string().trim().min(3)).max(20).optional(),
    dependsOn: z.array(z.string().uuid()).max(20).optional(),
    reason: z.string().trim().min(1),
}).refine(
    (p) => p.title !== undefined || p.task !== undefined || p.acceptanceCriteria !== undefined || p.dependsOn !== undefined,
    { message: 'propose at least one of title, task, acceptanceCriteria, dependsOn' },
);

export type GildeProposal = z.infer<typeof gildeProposalSchema>;

export interface ParsedPrBody {
    jobId: string | null;
    runId: string | null;
    result: GildeResult | null;
    resultError: string | null;
    retro: string | null;
    /** The valid entries of the optional gilde-proposals block. */
    proposals: GildeProposal[];
    proposalsError: string | null;
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

function findId(body: string, label: string): string | null {
    const match = new RegExp(`^[ \\t]*${label}:[ \\t]*(${UUID})[ \\t]*$`, 'm').exec(body);
    return match ? match[1].toLowerCase() : null;
}

function parseResult(body: string): { result: GildeResult | null; resultError: string | null } {
    const block = /^```gilde-result[ \t]*\r?\n([\s\S]*?)\r?\n```/m.exec(body);
    if (!block) return { result: null, resultError: 'missing gilde-result block' };

    let json: unknown;
    try {
        json = JSON.parse(block[1]);
    } catch {
        return { result: null, resultError: 'gilde-result is not valid JSON' };
    }

    const parsed = gildeResultBaseSchema.safeParse(json);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
        return { result: null, resultError: `invalid gilde-result: ${issues.join('; ')}` };
    }
    const { actions, error } = parseOperatorActions((json as Record<string, unknown>).operatorActions);
    return {
        result: actions.length ? { ...parsed.data, operatorActions: actions } : parsed.data,
        resultError: error,
    };
}

/** Valid entries are kept; an invalid entry, a non-array or more than the maximum is an error that never drops the rest of the result. */
function parseOperatorActions(raw: unknown): { actions: OperatorAction[]; error: string | null } {
    if (raw === undefined) return { actions: [], error: null };
    if (!Array.isArray(raw)) return { actions: [], error: 'invalid operatorActions: must be an array' };
    if (raw.length > MAX_OPERATOR_ACTIONS) return { actions: [], error: `invalid operatorActions: at most ${MAX_OPERATOR_ACTIONS} allowed` };

    const actions: OperatorAction[] = [];
    const errors: string[] = [];
    raw.forEach((entry, i) => {
        const parsed = operatorActionSchema.safeParse(entry);
        if (parsed.success) {
            actions.push(parsed.data);
            return;
        }
        const issues = parsed.error.issues.map((x) => `${x.path.join('.') || '(entry)'}: ${x.message}`);
        errors.push(`operatorActions ${i}: ${issues.join(', ')}`);
    });
    return { actions, error: errors.length ? `invalid operatorActions: ${errors.join('; ')}` : null };
}

function parseProposals(body: string): { proposals: GildeProposal[]; proposalsError: string | null } {
    const block = /^```gilde-proposals[ \t]*\r?\n([\s\S]*?)\r?\n```/m.exec(body);
    if (!block) return { proposals: [], proposalsError: null };

    let json: unknown;
    try {
        json = JSON.parse(block[1]);
    } catch {
        return { proposals: [], proposalsError: 'gilde-proposals is not valid JSON' };
    }
    if (!Array.isArray(json)) return { proposals: [], proposalsError: 'gilde-proposals must be a JSON array' };

    const proposals: GildeProposal[] = [];
    const errors: string[] = [];
    json.forEach((entry, i) => {
        const parsed = gildeProposalSchema.safeParse(entry);
        if (parsed.success) {
            proposals.push(parsed.data);
            return;
        }
        const issues = parsed.error.issues.map((x) => `${x.path.join('.') || '(entry)'}: ${x.message}`);
        errors.push(`proposal ${i}: ${issues.join(', ')}`);
    });
    return { proposals, proposalsError: errors.length ? `invalid gilde-proposals: ${errors.join('; ')}` : null };
}

function parseRetro(body: string): string | null {
    const lines = body.split(/\r?\n/);
    const start = lines.findIndex((l) => /^##[ \t]+Retro[ \t]*$/i.test(l));
    if (start === -1) return null;
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^##[ \t]/.test(l));
    const text = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
    return text || null;
}

/** Extracts the Gilde metadata from a PR description. Never throws. */
export function parsePrBody(body: string | null | undefined): ParsedPrBody {
    const text = typeof body === 'string' ? body : '';
    try {
        return {
            jobId: findId(text, 'gilde-job'),
            runId: findId(text, 'gilde-run'),
            ...parseResult(text),
            retro: parseRetro(text),
            ...parseProposals(text),
        };
    } catch {
        return { jobId: null, runId: null, result: null, resultError: 'could not parse PR body', retro: null, proposals: [], proposalsError: null };
    }
}
