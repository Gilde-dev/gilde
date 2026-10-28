import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(
    secret: string | undefined,
    rawBody: Buffer | undefined,
    header: string | undefined,
): boolean {
    if (!secret || !rawBody || !header) return false;
    const expected = Buffer.from(
        `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
    );
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The secrets a delivery may be signed with: the app's webhook secret and the per-repo one, whichever are set. */
export function webhookSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
    return [env.GITHUB_APP_WEBHOOK_SECRET, env.GITHUB_WEBHOOK_SECRET].filter((s): s is string => !!s);
}

/** True when the signature matches any of the secrets. Every secret is checked so timing does not reveal which one is set. */
export function verifyAnySignature(
    secrets: string[],
    rawBody: Buffer | undefined,
    header: string | undefined,
): boolean {
    return secrets.map((s) => verifySignature(s, rawBody, header)).some(Boolean);
}
