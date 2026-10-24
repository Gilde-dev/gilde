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
