import { createHmac } from 'node:crypto';

import { verifyAnySignature, verifySignature, webhookSecrets } from './webhook-signature.js';

const secret = 's3cret';
const body = Buffer.from('{"zen":"Keep it logically awesome."}');
const sign = (s: string, b: Buffer) => `sha256=${createHmac('sha256', s).update(b).digest('hex')}`;

describe('verifySignature', () => {
    it('accepts a valid signature', () => {
        expect(verifySignature(secret, body, sign(secret, body))).toBe(true);
    });

    it('rejects a tampered body', () => {
        expect(verifySignature(secret, Buffer.from('{"zen":"x"}'), sign(secret, body))).toBe(false);
    });

    it('rejects a wrong secret', () => {
        expect(verifySignature(secret, body, sign('other', body))).toBe(false);
    });

    it('rejects a missing header', () => {
        expect(verifySignature(secret, body, undefined)).toBe(false);
    });

    it('rejects a header of the wrong length', () => {
        expect(verifySignature(secret, body, 'sha256=abc')).toBe(false);
    });

    it('rejects when no secret is configured or no raw body is present', () => {
        expect(verifySignature(undefined, body, sign(secret, body))).toBe(false);
        expect(verifySignature(secret, undefined, sign(secret, body))).toBe(false);
    });
});

describe('verifyAnySignature', () => {
    const secrets = webhookSecrets({ GITHUB_APP_WEBHOOK_SECRET: 'app-secret', GITHUB_WEBHOOK_SECRET: 'repo-secret' });

    it('accepts a delivery signed with either secret', () => {
        expect(verifyAnySignature(secrets, body, sign('app-secret', body))).toBe(true);
        expect(verifyAnySignature(secrets, body, sign('repo-secret', body))).toBe(true);
        expect(verifyAnySignature(secrets, body, sign('other', body))).toBe(false);
    });

    it('works with only one secret set', () => {
        expect(verifyAnySignature(webhookSecrets({ GITHUB_APP_WEBHOOK_SECRET: 'app-secret' }), body, sign('app-secret', body))).toBe(true);
        expect(verifyAnySignature(webhookSecrets({ GITHUB_WEBHOOK_SECRET: 'repo-secret' }), body, sign('app-secret', body))).toBe(false);
    });

    it('rejects everything when neither secret is set', () => {
        expect(webhookSecrets({})).toEqual([]);
        expect(verifyAnySignature([], body, sign('', body))).toBe(false);
    });
});
