import { z } from 'zod';

export const gildeResultSchema = z.object({
    outcome: z.enum(['done', 'partial', 'blocked']),
    summary: z.string(),
    testsRun: z.boolean().optional(),
    testsPassed: z.boolean().optional(),
    suggestedLesson: z.string().nullable().optional(),
});

export type GildeResult = z.infer<typeof gildeResultSchema>;

export interface ParsedPrBody {
    jobId: string | null;
    runId: string | null;
    result: GildeResult | null;
    resultError: string | null;
    retro: string | null;
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
        };
    } catch {
        return { jobId: null, runId: null, result: null, resultError: 'could not parse PR body', retro: null };
    }
}
