/** The six H2 sections of a spec, in this exact order. */
export const SPEC_SECTIONS = ['Goal', 'Context', 'Behaviour', 'Acceptance criteria', 'Out of scope', 'Open questions'] as const;
export type SpecSection = (typeof SPEC_SECTIONS)[number];

/** The template for a new spec; also the one in the README. */
export const SPEC_TEMPLATE = `## Goal

What this change achieves and for whom.

## Context

What exists today and why it matters.

## Behaviour

What the system does once this is built.

## Acceptance criteria

- AC-1: A concrete, checkable outcome.

## Out of scope

What this spec deliberately leaves out.

## Open questions

None
`;

export interface ParseIssue {
    /** 1-based line in the body; null when the problem is not tied to a line. */
    line: number | null;
    message: string;
}

export interface ParsedCriterion {
    /** The number of `AC-<number>`. */
    number: number;
    /** `AC-<number>`. */
    id: string;
    text: string;
}

export interface ParsedSpec {
    /** Structural problems; a body with any of them cannot be saved. */
    issues: ParseIssue[];
    criteria: ParsedCriterion[];
    /** The open questions found, one per list item or line; empty when the section is empty or only "None". */
    openQuestions: string[];
}

/** What earlier versions of a spec established about acceptance-criteria numbers. */
export interface CriteriaHistory {
    /** Numbers in the newest saved version. */
    latest: readonly number[];
    /** Numbers in any saved version, ever. */
    ever: readonly number[];
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const H2 = /^ {0,3}##(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const CRITERION = /^AC-(\d+)(?![\w-])[ \t]*[:.\-–—)]?[ \t]*(.*)$/;
const MAX_QUESTIONS = 20;

/** Splits on LF, CRLF and CR without altering the body itself. */
function linesOf(body: string): string[] {
    return body.split(/\r\n|\n|\r/);
}

/** Per line: whether it lies inside (or on the edge of) a fenced code block. Unclosed fences run to the end. */
function fencedLines(lines: string[]): boolean[] {
    const fenced: boolean[] = [];
    let open: { char: string; length: number } | null = null;
    for (const line of lines) {
        const m = FENCE.exec(line);
        if (!open) {
            if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
                open = { char: m[1][0], length: m[1].length };
                fenced.push(true);
            } else {
                fenced.push(false);
            }
            continue;
        }
        fenced.push(true);
        if (m && m[1][0] === open.char && m[1].length >= open.length && m[2].trim() === '') open = null;
    }
    return fenced;
}

/** Parses the structure of a spec body. Fenced code never counts as a heading, criterion or list item. */
export function parseSpec(body: string): ParsedSpec {
    const lines = linesOf(body);
    const fenced = fencedLines(lines);
    const issues: ParseIssue[] = [];

    const headings: Array<{ title: string; line: number }> = [];
    lines.forEach((text, i) => {
        if (fenced[i]) return;
        const m = H2.exec(text);
        if (m) headings.push({ title: (m[1] ?? '').trim(), line: i + 1 });
    });

    const expected: readonly string[] = SPEC_SECTIONS;
    const seen = new Set<string>();
    for (const h of headings) {
        if (!expected.includes(h.title)) issues.push({ line: h.line, message: `Unexpected H2 heading "${h.title}"; the only H2 headings are ${SPEC_SECTIONS.join(', ')}` });
        else if (seen.has(h.title)) issues.push({ line: h.line, message: `Duplicate H2 heading "${h.title}"` });
        seen.add(h.title);
    }
    for (const s of SPEC_SECTIONS) if (!seen.has(s)) issues.push({ line: null, message: `Missing H2 heading "${s}"` });
    const known = headings.filter((h) => expected.includes(h.title)).map((h) => h.title);
    const firsts = known.filter((t, i) => known.indexOf(t) === i);
    const inOrder = SPEC_SECTIONS.filter((s) => firsts.includes(s));
    if (firsts.some((t, i) => t !== inOrder[i])) issues.push({ line: null, message: `H2 headings must appear in this order: ${SPEC_SECTIONS.join(', ')}` });

    // A section runs to the next H2 of any kind.
    const sectionRange = (title: string): [number, number] | null => {
        const at = headings.findIndex((h) => h.title === title);
        if (at < 0) return null;
        return [headings[at].line, headings[at + 1]?.line ?? lines.length + 1];
    };

    const criteria: ParsedCriterion[] = [];
    const ac = sectionRange('Acceptance criteria');
    if (ac) criteria.push(...parseCriteria(lines, fenced, ac, issues));
    if (ac && criteria.length === 0 && !issues.some((i) => i.line !== null && i.line > ac[0] && i.line < ac[1])) {
        issues.push({ line: ac[0], message: 'Acceptance criteria needs at least one "AC-<number>: text" list item' });
    }
    const numbers = new Set<number>();
    for (const c of criteria) {
        if (numbers.has(c.number)) issues.push({ line: null, message: `Duplicate acceptance criterion id ${c.id}` });
        numbers.add(c.number);
    }

    const openQuestions: string[] = [];
    const oq = sectionRange('Open questions');
    if (oq) {
        const raw = lines.slice(oq[0], oq[1] - 1);
        const text = raw.join('\n').trim();
        if (text !== '' && !/^(?:[-*+][ \t]+)?none\.?$/i.test(text)) {
            raw.forEach((line, i) => {
                const t = line.trim();
                if (!t) return;
                if (fenced[oq[0] + i] && /^(`{3,}|~{3,})/.test(t)) return;
                const item = ITEM.exec(line);
                openQuestions.push((item ? item[3] : t).trim());
            });
        }
    }
    return { issues, criteria, openQuestions: openQuestions.slice(0, MAX_QUESTIONS) };
}

function parseCriteria(lines: string[], fenced: boolean[], [from, to]: [number, number], issues: ParseIssue[]): ParsedCriterion[] {
    const out: ParsedCriterion[] = [];
    let current: { number: number; text: string[]; line: number } | null = null;
    const flush = () => {
        if (!current) return;
        const text = current.text.join(' ').replace(/\s+/g, ' ').trim();
        if (!text) issues.push({ line: current.line, message: `AC-${current.number} has no text` });
        else out.push({ number: current.number, id: `AC-${current.number}`, text });
        current = null;
    };
    for (let i = from; i < to - 1; i++) {
        const line = lines[i];
        const lineNo = i + 1;
        if (fenced[i]) {
            if (current) current.text.push(line.trim());
            continue;
        }
        if (line.trim() === '') continue;
        const item = ITEM.exec(line);
        if (item) {
            flush();
            const label = CRITERION.exec(item[3].trim());
            if (!label) {
                issues.push({ line: lineNo, message: `Unlabelled criterion "${item[3].trim().slice(0, 60)}"; every list item must start with AC-<number>` });
                continue;
            }
            const digits = label[1];
            const number = Number(digits);
            if (digits.startsWith('0') || !Number.isSafeInteger(number) || number < 1) {
                issues.push({ line: lineNo, message: `Criterion id AC-${digits} must be a positive integer without leading zeros` });
                continue;
            }
            current = { number, text: [label[2]], line: lineNo };
            continue;
        }
        if (current && /^\s{2,}\S|^\t/.test(line)) {
            current.text.push(line.trim());
            continue;
        }
        flush();
        issues.push({ line: lineNo, message: `Unlabelled content in Acceptance criteria; every criterion is a list item starting with AC-<number>` });
    }
    flush();
    return out;
}

/**
 * Cross-version rules for criteria numbers: a number that left the latest version is retired for good, a number that
 * never existed must exceed every number ever used, and numbers that stay keep theirs. Returns the problems found.
 */
export function checkCriteriaHistory(criteria: readonly ParsedCriterion[], history: CriteriaHistory): ParseIssue[] {
    const issues: ParseIssue[] = [];
    const latest = new Set(history.latest);
    const ever = new Set(history.ever);
    const max = Math.max(0, ...history.ever);
    for (const c of criteria) {
        if (latest.has(c.number)) continue;
        if (ever.has(c.number)) issues.push({ line: null, message: `${c.id} was retired in an earlier version and cannot return; use a new id above AC-${max}` });
        else if (c.number <= max) issues.push({ line: null, message: `${c.id} is new but not above the historical maximum AC-${max}; criteria are never renumbered, new ones continue after AC-${max}` });
    }
    return issues;
}

/** Reasons a version cannot be approved yet; empty when it can. Saving is never blocked by these. */
export function approvalBlockers(parsed: Pick<ParsedSpec, 'openQuestions'>): string[] {
    return parsed.openQuestions.map((q) => `Open question: ${q.length > 200 ? `${q.slice(0, 197)}...` : q}`);
}
