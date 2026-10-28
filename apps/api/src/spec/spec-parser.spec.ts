import { SPEC_TEMPLATE, approvalBlockers, checkCriteriaHistory, parseSpec } from './spec-parser.js';

const spec = (over: Partial<Record<string, string>> = {}) => {
    const sections: Record<string, string> = {
        Goal: 'Do it.',
        Context: 'Because.',
        Behaviour: 'It works.',
        'Acceptance criteria': '- AC-1: First\n- AC-2: Second',
        'Out of scope': 'Nothing.',
        'Open questions': 'None',
        ...over,
    };
    return Object.entries(sections).map(([h, t]) => `## ${h}\n\n${t}\n`).join('\n');
};
const messages = (body: string) => parseSpec(body).issues.map((i) => i.message);

describe('parseSpec', () => {
    it('accepts the template', () => {
        const p = parseSpec(SPEC_TEMPLATE);
        expect(p.issues).toEqual([]);
        expect(p.criteria).toEqual([{ number: 1, id: 'AC-1', text: 'A concrete, checkable outcome.' }]);
        expect(p.openQuestions).toEqual([]);
    });

    it('accepts CRLF, a title above the sections and level-3 headings', () => {
        const body = `# Title\n\n${spec()}\n### Detail\n`.replace(/\n/g, '\r\n');
        expect(parseSpec(body).issues).toEqual([]);
    });

    describe('sections', () => {
        it('reports each missing heading', () => {
            expect(messages('## Goal\n\nx\n')).toEqual(expect.arrayContaining(['Missing H2 heading "Context"', 'Missing H2 heading "Open questions"']));
        });

        it('rejects duplicate, unknown and misordered headings', () => {
            expect(messages(`${spec()}\n## Goal\n`)).toContain('Duplicate H2 heading "Goal"');
            expect(messages(`${spec()}\n## Extras\n`).join()).toContain('Unexpected H2 heading "Extras"');
            const swapped = spec().replace('## Goal', '## TMP').replace('## Context', '## Goal').replace('## TMP', '## Context');
            expect(messages(swapped).join()).toContain('must appear in this order');
        });

        it('is case-sensitive and ignores trailing hashes', () => {
            expect(messages(spec().replace('## Goal', '## goal')).join()).toContain('Unexpected H2 heading "goal"');
            expect(parseSpec(spec().replace('## Goal', '## Goal ##')).issues).toEqual([]);
        });

        it('ignores headings inside fenced code', () => {
            const body = spec({ Behaviour: '```md\n## Goal\n## Nonsense\n```\n\n~~~\n## Context\n~~~' });
            expect(parseSpec(body).issues).toEqual([]);
        });

        it('keeps a longer fence open past a shorter fence line', () => {
            const body = spec({ Behaviour: '````\n```\n## Goal\n```\n````' });
            expect(parseSpec(body).issues).toEqual([]);
        });

        it('treats an unclosed fence as running to the end', () => {
            const body = spec({ 'Open questions': 'None' }) + '\n```\n## Goal\n';
            expect(parseSpec(body).issues).toEqual([]);
        });

        it('does not treat H1, H3 or indented-code lines as H2', () => {
            expect(parseSpec(spec({ Behaviour: '# One\n### Three\n    ## Goal' })).issues).toEqual([]);
        });
    });

    describe('acceptance criteria', () => {
        it('parses ids, text, numbered lists and continuation lines', () => {
            const p = parseSpec(spec({ 'Acceptance criteria': '1. AC-3: Third\n   more text\n* AC-10 - Tenth' }));
            expect(p.issues).toEqual([]);
            expect(p.criteria).toEqual([
                { number: 3, id: 'AC-3', text: 'Third more text' },
                { number: 10, id: 'AC-10', text: 'Tenth' },
            ]);
        });

        it('requires at least one criterion', () => {
            expect(messages(spec({ 'Acceptance criteria': 'Nothing yet' }))).toEqual(expect.arrayContaining([expect.stringContaining('Unlabelled content')]));
            expect(messages(spec({ 'Acceptance criteria': '' }))).toContain('Acceptance criteria needs at least one "AC-<number>: text" list item');
        });

        it('rejects unlabelled items, empty text, zero, leading zeros and duplicates', () => {
            expect(messages(spec({ 'Acceptance criteria': '- AC-1: ok\n- plain item' })).join()).toContain('Unlabelled criterion');
            expect(messages(spec({ 'Acceptance criteria': '- AC-1:' })).join()).toContain('AC-1 has no text');
            expect(messages(spec({ 'Acceptance criteria': '- AC-0: zero' })).join()).toContain('positive integer');
            expect(messages(spec({ 'Acceptance criteria': '- AC-01: padded' })).join()).toContain('leading zeros');
            expect(messages(spec({ 'Acceptance criteria': '- AC-1: a\n- AC-1: b' }))).toContain('Duplicate acceptance criterion id AC-1');
            expect(messages(spec({ 'Acceptance criteria': '- ACx: nope\n- AC-1a: nope' })).filter((m) => m.startsWith('Unlabelled criterion'))).toHaveLength(2);
        });

        it('ignores list items in fenced code', () => {
            const p = parseSpec(spec({ 'Acceptance criteria': '- AC-1: real\n\n```\n- not a criterion\n```' }));
            expect(p.issues).toEqual([]);
            expect(p.criteria).toHaveLength(1);
        });

        it('does not take criteria from other sections', () => {
            const p = parseSpec(spec({ Behaviour: '- AC-9: not here' }));
            expect(p.criteria.map((c) => c.id)).toEqual(['AC-1', 'AC-2']);
        });
    });

    describe('open questions', () => {
        it.each(['', 'None', 'none.', '- None', '  \n\n'])('resolves %j', (text) => {
            const p = parseSpec(spec({ 'Open questions': text }));
            expect(p.issues).toEqual([]);
            expect(p.openQuestions).toEqual([]);
            expect(approvalBlockers(p)).toEqual([]);
        });

        it('lists each open question as an approval blocker but still parses', () => {
            const p = parseSpec(spec({ 'Open questions': '- Which database?\n- Who owns it?' }));
            expect(p.issues).toEqual([]);
            expect(approvalBlockers(p)).toEqual(['Open question: Which database?', 'Open question: Who owns it?']);
        });

        it('treats None among other text as open', () => {
            expect(approvalBlockers(parseSpec(spec({ 'Open questions': 'None of the above is decided' })))).toHaveLength(1);
        });

        it('counts fenced content as open', () => {
            expect(approvalBlockers(parseSpec(spec({ 'Open questions': '```\nunsure\n```' })))).toEqual(['Open question: unsure']);
        });
    });
});

describe('checkCriteriaHistory', () => {
    const c = (...numbers: number[]) => numbers.map((n) => ({ number: n, id: `AC-${n}`, text: 't' }));

    it('accepts surviving ids and new ids above the historical maximum', () => {
        expect(checkCriteriaHistory(c(1, 2, 5), { latest: [1, 2], ever: [1, 2, 3] })).toEqual([]);
        expect(checkCriteriaHistory(c(1, 4), { latest: [1, 2], ever: [1, 2, 3] })).toEqual([]);
    });

    it('refuses a retired id', () => {
        const issues = checkCriteriaHistory(c(1, 3), { latest: [1], ever: [1, 2, 3] });
        expect(issues.map((i) => i.message).join()).toContain('AC-3 was retired');
    });

    it('refuses a new id at or below the historical maximum, even when it was never used', () => {
        const issues = checkCriteriaHistory(c(1, 2), { latest: [1], ever: [1, 5] });
        expect(issues.map((i) => i.message).join()).toContain('AC-2 is new but not above the historical maximum AC-5');
    });

    it('keeps a retired maximum: dropping the highest id does not free it', () => {
        expect(checkCriteriaHistory(c(1, 3), { latest: [1], ever: [1, 2, 3] })).not.toEqual([]);
        expect(checkCriteriaHistory(c(1, 4), { latest: [1], ever: [1, 2, 3] })).toEqual([]);
    });

    it('allows anything for the first version', () => {
        expect(checkCriteriaHistory(c(7, 2), { latest: [], ever: [] })).toEqual([]);
    });
});
