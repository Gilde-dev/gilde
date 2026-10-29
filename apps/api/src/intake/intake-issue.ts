import { createHash } from 'node:crypto';

import type { IntakeComment } from './intake-item.entity.js';

export const INTAKE_BODY_LIMIT = 20000;
export const INTAKE_COMMENT_LIMIT = 4000;
export const INTAKE_COMMENT_MAX = 20;

/** An issue as the intake rules see it, whether it came from a webhook or from the sweep. */
export interface IntakeIssue {
    nodeId: string;
    number: number;
    url: string;
    title: string;
    body: string | null;
    open: boolean;
    authorLogin: string | null;
    labels: string[];
}

/** The label that opts an issue in. GitHub compares label names case-insensitively, so this does too. */
export const intakeLabel = (): string => (process.env.INTAKE_LABEL?.trim() || 'gilde:refine').toLowerCase();

export const hasIntakeLabel = (labels: string[]): boolean => labels.some((l) => l.trim().toLowerCase() === intakeLabel());

export const issueSha = (title: string, body: string | null): string =>
    createHash('sha256').update(`${title}\n${body ?? ''}`).digest('hex');

export const capBody = (body: string | null): { body: string; truncated: boolean } => {
    const text = body ?? '';
    return text.length > INTAKE_BODY_LIMIT ? { body: text.slice(0, INTAKE_BODY_LIMIT), truncated: true } : { body: text, truncated: false };
};

/**
 * What a draft is made from: the issue title and body plus the trusted comments. Without comments it is the body sha itself,
 * so items from before comments existed keep their sha. A re-delivered, unchanged comment gives the same value.
 */
export const refineSha = (item: { bodySha256: string; comments?: readonly IntakeComment[] | null }): string => {
    if (!item.comments?.length) return item.bodySha256;
    const hash = createHash('sha256').update(item.bodySha256);
    for (const c of item.comments) hash.update(`\n${c.id}\n${c.author}\n${c.body}`);
    return hash.digest('hex');
};

/** Adds or replaces (by id) a comment, caps its body and keeps the INTAKE_COMMENT_MAX most recent, oldest first. */
export const withComment = (comments: readonly IntakeComment[], next: IntakeComment): IntakeComment[] => {
    const capped = { ...next, body: next.body.slice(0, INTAKE_COMMENT_LIMIT) };
    const all = [...comments.filter((c) => c.id !== next.id), capped];
    all.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || Number(BigInt(a.id) - BigInt(b.id)));
    return all.slice(-INTAKE_COMMENT_MAX);
};
