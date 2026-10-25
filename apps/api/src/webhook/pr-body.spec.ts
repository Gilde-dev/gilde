import { parsePrBody } from './pr-body.js';

const JOB = '1c28bc8f-4a6b-4d94-8eb7-c02bf4cc8946';
const RUN = '114ca104-8691-4674-8dad-50e12cf2ac6f';
const RESULT = '{"outcome":"done","summary":"Added it","testsRun":true,"testsPassed":true,"suggestedLesson":null}';

const block = (json: string) => '```gilde-result\n' + json + '\n```';

const full = [
    'Did the thing.',
    '',
    `gilde-job: ${JOB}`,
    `gilde-run: ${RUN}`,
    '',
    block(RESULT),
    '',
    '## Retro',
    '- What I changed: a',
    '- What slowed me down: b',
    '',
    '## Notes',
    'unrelated',
].join('\n');

describe('parsePrBody', () => {
    it('parses a full body', () => {
        expect(parsePrBody(full)).toEqual({
            jobId: JOB,
            runId: RUN,
            result: { outcome: 'done', summary: 'Added it', testsRun: true, testsPassed: true, suggestedLesson: null },
            resultError: null,
            retro: '- What I changed: a\n- What slowed me down: b',
            proposals: [],
            proposalsError: null,
        });
    });

    it('reads the retro up to the end when it is the last section', () => {
        const body = `gilde-job: ${JOB}\n${block(RESULT)}\n\n## Retro\nline one\nline two\n`;
        expect(parsePrBody(body).retro).toBe('line one\nline two');
    });

    it('returns a resultError for a missing result block', () => {
        const parsed = parsePrBody(`gilde-job: ${JOB}\ngilde-run: ${RUN}\n`);
        expect(parsed.result).toBeNull();
        expect(parsed.resultError).toMatch(/missing/);
        expect(parsed.jobId).toBe(JOB);
    });

    it('returns a resultError for invalid JSON', () => {
        const parsed = parsePrBody(block('{not json'));
        expect(parsed.result).toBeNull();
        expect(parsed.resultError).toMatch(/not valid JSON/);
    });

    it('returns a resultError for an invalid outcome', () => {
        const parsed = parsePrBody(block('{"outcome":"great","summary":"x"}'));
        expect(parsed.result).toBeNull();
        expect(parsed.resultError).toMatch(/outcome/);
    });

    it('returns nulls for a non-Gilde PR body', () => {
        expect(parsePrBody('Fixes a typo.\n\n## Testing\nnone')).toEqual({
            jobId: null,
            runId: null,
            result: null,
            resultError: 'missing gilde-result block',
            retro: null,
            proposals: [],
            proposalsError: null,
        });
    });

    it('never throws on null, undefined or non-string input', () => {
        expect(() => parsePrBody(null)).not.toThrow();
        expect(() => parsePrBody(undefined)).not.toThrow();
        expect(() => parsePrBody(42 as unknown as string)).not.toThrow();
    });

    describe('gilde-proposals', () => {
        const proposals = (json: string) => `${full}\n\n\`\`\`gilde-proposals\n${json}\n\`\`\``;
        const OTHER = '2d0e1f3a-4b5c-4d6e-8f70-819293a4b5c6';

        it('parses valid entries', () => {
            const parsed = parsePrBody(proposals(`[{"jobId":"${OTHER}","task":"Rename the endpoint to /v2/things","reason":"I renamed it"}]`));
            expect(parsed.proposalsError).toBeNull();
            expect(parsed.proposals).toEqual([{ jobId: OTHER, task: 'Rename the endpoint to /v2/things', reason: 'I renamed it' }]);
            expect(parsed.result?.outcome).toBe('done');
        });

        it('reports invalid JSON without touching the result', () => {
            const parsed = parsePrBody(proposals('[{oops'));
            expect(parsed.proposals).toEqual([]);
            expect(parsed.proposalsError).toBe('gilde-proposals is not valid JSON');
            expect(parsed.result?.outcome).toBe('done');
        });

        it('keeps valid entries and reports the invalid ones', () => {
            const parsed = parsePrBody(proposals(`[{"jobId":"${OTHER}","title":"New title","reason":"r"},{"jobId":"nope","reason":"r"},{"jobId":"${OTHER}","reason":"no change"}]`));
            expect(parsed.proposals).toHaveLength(1);
            expect(parsed.proposalsError).toMatch(/proposal 1: jobId.*proposal 2/);
        });

        it('rejects a block that is not an array', () => {
            expect(parsePrBody(proposals('{}')).proposalsError).toBe('gilde-proposals must be a JSON array');
        });
    });
});
