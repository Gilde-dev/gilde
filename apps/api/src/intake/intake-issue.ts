import { createHash } from 'node:crypto';

export const INTAKE_BODY_LIMIT = 20000;

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
