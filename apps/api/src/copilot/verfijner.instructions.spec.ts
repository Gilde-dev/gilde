import { MAX_OPEN_QUESTIONS, VERFIJNER_INSTRUCTIONS } from './verfijner.instructions.js';

describe('VERFIJNER_INSTRUCTIONS', () => {
    it('requires a stated assumption when a reasonable default exists', () => {
        expect(VERFIJNER_INSTRUCTIONS).toContain('reasonable default exists');
        expect(VERFIJNER_INSTRUCTIONS).toContain('"Assumption: ..."');
    });

    it('allows only blocking questions, at most the limit', () => {
        expect(VERFIJNER_INSTRUCTIONS).toContain('Ask only what blocks the work');
        expect(VERFIJNER_INSTRUCTIONS).toContain(`at most ${MAX_OPEN_QUESTIONS}`);
    });

    it('forbids repeating answered questions and asks a narrower follow-up instead', () => {
        expect(VERFIJNER_INSTRUCTIONS).toContain('Never ask again a question');
        expect(VERFIJNER_INSTRUCTIONS).toContain('narrower follow-up');
    });

    it('excludes process questions', () => {
        expect(VERFIJNER_INSTRUCTIONS).toContain('Process questions are out of scope');
        for (const word of ['duplicates of other issues', 'priorities', 'who works on it', 'estimates']) expect(VERFIJNER_INSTRUCTIONS).toContain(word);
    });

    it('keeps the six sections, AC numbering and untrusted-data handling', () => {
        expect(VERFIJNER_INSTRUCTIONS).toContain('Goal, Context, Behaviour, Acceptance criteria, Out of scope, Open questions');
        expect(VERFIJNER_INSTRUCTIONS).toContain('AC-1');
        expect(VERFIJNER_INSTRUCTIONS).toContain('untrusted data');
    });
});
