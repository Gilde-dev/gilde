import type { BlockingFinding, ReviewResult, Suggestion } from './review-result.js';
import { reviewMarker } from './review-marker.js';

/** GitHub accepts at most 65536 characters in a review body; stay well below it. */
const BODY_LIMIT = 60_000;
/** The part of a revision reason that carries the findings; the prompt as a whole is limited elsewhere. */
const REVISION_REASON_LIMIT = 16_000;

const where = (f: { path?: string; line?: number }) => (f.path ? ` (\`${f.path}${f.line ? `:${f.line}` : ''}\`)` : '');
const short = (sha: string | null) => (sha ? sha.slice(0, 7) : 'unknown');

function findingLines(f: BlockingFinding, n: number): string[] {
    return [`${n}. **${f.title}**${where(f)}`, `   - Evidence: ${f.evidence}`, `   - Impact: ${f.impact}`, `   - Requested fix: ${f.requestedFix}`];
}

function suggestionLines(s: Suggestion, n: number): string[] {
    return [`${n}. **${s.title}**${where(s)}: ${s.detail}`];
}

/**
 * The body of the COMMENT review published for a head: the reviewed SHA first, then the verdict, the coverage that concerns
 * this job, blocking findings and suggestions apart. An incomplete result says so and never reads like a pass. Starts with
 * the marker, so an uncertain publication can be found again.
 */
export function renderReviewBody(review: { id: string; headSha: string; baseSha: string | null }, result: ReviewResult): string {
    const lines: string[] = [reviewMarker(review.id, review.headSha)];
    const reviewed = `Reviewed commit \`${short(review.headSha)}\`${review.baseSha ? ` against base \`${short(review.baseSha)}\`` : ''}.`;
    if (result.kind === 'complete') {
        lines.push(`## Gilde automatic review: ${result.verdict === 'pass' ? 'no blocking issues' : 'blocking issues found'}`, reviewed, '', result.summary);
        const relevant = result.coverage.filter((c) => c.relevance === 'relevant');
        if (relevant.length) {
            lines.push('', '### Acceptance criteria');
            for (const c of relevant) lines.push(`- \`${c.criterionId}\`: **${c.status}**. ${c.explanation}`);
        }
        if (result.blockingFindings.length) {
            lines.push('', '### Blocking findings');
            result.blockingFindings.forEach((f, i) => lines.push(...findingLines(f, i + 1)));
        }
        if (result.suggestions.length) {
            lines.push('', '### Suggestions (not blocking)');
            result.suggestions.forEach((s, i) => lines.push(...suggestionLines(s, i + 1)));
        }
    } else if (result.kind === 'incomplete') {
        lines.push('## Gilde automatic review: incomplete (not a pass)', reviewed, '', `The review could not inspect everything: ${result.reason}. A person needs to review this PR.`);
        if (result.partialFindings.length) {
            lines.push('', '### Findings before the review stopped');
            result.partialFindings.forEach((f, i) => lines.push(...findingLines(f, i + 1)));
        }
        if (result.suggestions.length) {
            lines.push('', '### Suggestions');
            result.suggestions.forEach((s, i) => lines.push(...suggestionLines(s, i + 1)));
        }
    } else {
        lines.push('## Gilde automatic review', reviewed, '', result.reason);
    }
    const body = lines.join('\n');
    return body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}\n\n… (cut; the full result is on the job in Gilde)` : body;
}

/**
 * The text of a same-PR revision (`continueOn.reason`): every requested fix of the blocking result, nothing from suggestions.
 * The findings are the reviewer's output about this diff, to be checked against the code before acting on them.
 */
export function revisionReason(review: { headSha: string; publicationUrl: string | null }, findings: BlockingFinding[]): string {
    const head = `The automatic review of commit ${short(review.headSha)} found ${findings.length} blocking issue${findings.length === 1 ? '' : 's'}. Fix all of them on the existing branch and PR; do not open a new PR.`;
    const link = review.publicationUrl ? `\nReview: ${review.publicationUrl}` : '';
    const parts = findings.map((f, i) => findingLines(f, i + 1).join('\n'));
    let body = parts.join('\n');
    if (body.length > REVISION_REASON_LIMIT) body = `${body.slice(0, REVISION_REASON_LIMIT)}\n… (more findings in the review on GitHub)`;
    return `${head}${link}\n\n${body}`;
}

/** The reason a job is parked or handed to a human because of its automatic review, with the findings it holds. */
export function parkReason(limit: string, review: { headSha: string; publicationUrl: string | null }, findings: BlockingFinding[]): string {
    return `Automatic review: ${limit}. The blocking findings are not sent back again; a person decides.\n\n${revisionReason(review, findings)}`;
}
