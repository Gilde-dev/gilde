import { createHash } from 'node:crypto';

import { GitHubRequestError } from '../github/github.port.js';

export const INTAKE_COMMENT_INTERVAL_MS = 60_000;

/** The hidden marker that finds Gilde's one status comment of an intake item. */
export const commentMarker = (itemId: string): string => `<!-- gilde:intake:${itemId} -->`;

export type IntakeCommentStatus = 'draft' | 'waiting for answers' | 'ready to approve' | 'approved' | 'planned' | 'refine failed';

export interface IntakeCommentView {
    itemId: string;
    status: IntakeCommentStatus;
    /** Absent when nothing was drafted yet (a failed first refine). */
    spec: { title: string; version: number; link: string; criteria: number; summary: string | null; openQuestions: string[] } | null;
    /** For `refine failed`: a fixed, safe sentence. */
    failure: string | null;
}

/** Markdown, short: status, link, questions verbatim and how to answer. Never the spec body, secrets or other repos' data. */
export function renderStatusComment(view: IntakeCommentView): string {
    const lines = [commentMarker(view.itemId), ''];
    const s = view.spec;
    lines.push(s
        ? `**Gilde** · [${escapeLink(s.title)}](${s.link}) · version ${s.version} · **${view.status}**`
        : `**Gilde** · **${view.status}**`);
    if (view.failure) lines.push('', view.failure);
    if (s) {
        lines.push('', `${s.criteria} acceptance ${s.criteria === 1 ? 'criterion' : 'criteria'}${s.summary ? `: ${s.summary}` : '.'}`);
        if (s.openQuestions.length) {
            lines.push('', '**Open questions**', '', ...s.openQuestions.map((q, i) => `${i + 1}. ${q.replace(/\s*\n\s*/g, ' ')}`));
            lines.push('', 'Reply to this issue with your answers (for example `1. …`); Gilde will update the spec.');
        }
    }
    return lines.join('\n');
}

export const commentSha = (content: string): string => createHash('sha256').update(content).digest('hex');

/** The first line of the Goal section, cut to one short sentence. */
export function goalSummary(specBody: string): string | null {
    const m = /^ {0,3}##[ \t]+Goal[ \t]*\r?\n([\s\S]*?)(?=^ {0,3}##[ \t]|(?![\s\S]))/m.exec(specBody);
    const line = m?.[1].split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('```'));
    if (!line) return null;
    const plain = line.replace(/^[-*+]\s+/, '');
    return plain.length > 200 ? `${plain.slice(0, 199)}…` : plain;
}

const escapeLink = (text: string): string => text.replace(/[[\]\\]/g, '\\$&').replace(/\s+/g, ' ');

/** A short reason for the item that never carries GitHub's response, headers or anything secret. */
export function safeCommentError(error: unknown): string {
    if (error instanceof GitHubRequestError) {
        return error.status === 401 || error.status === 403 || error.status === 404
            ? `GitHub refused to write the status comment (HTTP ${error.status}). The GitHub App needs the Issues: write permission on this repo.`
            : `GitHub could not write the status comment (HTTP ${error.status}).`;
    }
    const message = error instanceof Error ? error.message : '';
    return /not installed/i.test(message)
        ? 'The Gilde GitHub App is not installed on this repo, so the status comment was not written.'
        : 'The status comment could not be written.';
}

/** The reason shown in the comment of a failed refine, from the stored error without leaking it. */
export function safeFailure(lastError: string | null): string {
    const e = lastError ?? '';
    const why = /without saving a spec/i.test(e) ? 'The agent finished without saving a valid spec.'
        : /time ?out|abort/i.test(e) ? 'The run took too long.'
            : 'The run failed.';
    return `Gilde could not draft a spec from this issue. ${why} A maintainer can retry it in Gilde.`;
}
