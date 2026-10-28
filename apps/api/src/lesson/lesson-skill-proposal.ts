import type { LessonPatternDto, ProposeSkillDto } from './lesson.dto.js';

const MAX_MEMBERS = 30;
const MAX_TEXT = 1000;
const MAX_REPRESENTATIVE = 2000;

/** Token shapes that must never reach a job text; lesson text is free-form and could quote a log. */
const SECRET_PATTERNS = [
    /\bgk_[A-Za-z0-9]+_[A-Za-z0-9]+\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

export function redactSecrets(text: string): string {
    return SECRET_PATTERNS.reduce((t, re) => t.replace(re, '[redacted]'), text);
}

const clip = (text: string, max: number) => {
    const t = redactSecrets(text).replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
};

export interface ProposalContext {
    projectId: string;
    /** Full names of the repos the pattern came from, by repo id. */
    repoNames: Map<string, string>;
    /** Names already in the library, so the agent does not duplicate them. */
    taken: string[];
    /** The library repo's test commands (its validation). */
    testCommands: string[];
    /** PR url by job id. */
    prUrls: Map<string, string | null>;
}

export const proposalTitle = (dto: ProposeSkillDto) => dto.title ?? `Add skill ${dto.name} to the skills library`;

export function proposalCriteria(dto: ProposeSkillDto): string[] {
    return [
        `skills/${dto.name}/SKILL.md exists with frontmatter name: ${dto.name} and a description, and is short and procedural`,
        `registry.yaml has an entry for ${dto.name} with scope ${dto.scope}${dto.scope === 'stack' ? ` and stacks ${dto.stacks!.join(', ')}` : ''}`,
        'The library validation (the repo test commands) passes',
        'The PR body lists the lesson ids this skill covers',
    ];
}

/** The task of a skill-proposal job: evidence is the pattern's lessons, verbatim (clipped, secrets redacted), with links. */
export function proposalTask(pattern: LessonPatternDto, dto: ProposeSkillDto, ctx: ProposalContext): string {
    const scope = dto.scope === 'stack' ? `scope stack, stacks [${dto.stacks!.join(', ')}]` : 'scope global';
    const shown = pattern.members.slice(0, MAX_MEMBERS);
    const evidence = shown.map((m) => {
        const links = [...new Map(m.sources.map((s) => [s.jobId, s])).values()]
            .slice(0, 5)
            .map((s) => `job /?project=${ctx.projectId}&job=${s.jobId}${s.prUrl ? ` (${s.prUrl})` : ''}`);
        return `- Lesson ${m.lessonId}: "${clip(m.text, MAX_TEXT)}"${links.length ? `\n  Seen in: ${links.join('; ')}` : ''}`;
    }).join('\n');
    const repos = pattern.repoIds.map((id) => ctx.repoNames.get(id)).filter((n): n is string => !!n);
    return [
        `Propose the library skill '${dto.name}' (${scope}) from a pattern of ${pattern.size} recurring lessons.`,
        `Representative lesson: "${clip(pattern.representativeText, MAX_REPRESENTATIVE)}"`,
        `Evidence (member lessons, verbatim, with the jobs and PRs they came from)${pattern.members.length > shown.length ? `, ${shown.length} of ${pattern.members.length}` : ''}:\n${evidence}`,
        repos.length ? `Repos the lessons came from: ${repos.join(', ')}.` : '',
        [
            'What to do:',
            `1. Write skills/${dto.name}/SKILL.md: YAML frontmatter with name: ${dto.name} and a description saying when to use it, then a short procedural body (steps an agent can follow), in the style of the existing skills in this library.`,
            `2. Add an entry for '${dto.name}' to registry.yaml with ${scope}.`,
            ctx.testCommands.length
                ? `3. Run the library validation: ${ctx.testCommands.map((c) => `\`${c}\``).join(', ')}. It must pass.`
                : '3. Run the validation this repo documents in AGENTS.md. It must pass.',
            '4. In the PR body, list the lesson ids above.',
        ].join('\n'),
        ctx.taken.length ? `These names are taken in the library, do not touch those skills: ${ctx.taken.join(', ')}.` : '',
        'Verify each lesson still holds before encoding it. If the pattern is wrong, already covered by an existing skill or cannot be written as a procedure, report outcome blocked and explain instead of adding a skill. Do not include secrets, tokens or full PR bodies in the skill.',
    ].filter(Boolean).join('\n\n');
}
