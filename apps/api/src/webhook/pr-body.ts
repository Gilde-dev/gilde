import { z } from 'zod';

export const gildeResultSchema = z.object({
    outcome: z.enum(['done', 'partial', 'blocked']),
    summary: z.string(),
    testsRun: z.boolean().optional(),
    testsPassed: z.boolean().optional(),
    suggestedLesson: z.string().nullable().optional(),
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

    const parsed = gildeResultSchema.safeParse(json);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
        return { result: null, resultError: `invalid gilde-result: ${issues.join('; ')}` };
    }
    return { result: parsed.data, resultError: null };
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
