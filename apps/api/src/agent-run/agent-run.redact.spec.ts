import { configuredSecrets, redact, redactAndCap, REDACTED, textOf } from './agent-run.redact.js';

describe('redact', () => {
    const tokens: Record<string, string> = {
        'Gilde API key': 'gk_ab12cd34_0123456789abcdef0123456789abcdef',
        'OpenAI key': 'sk-proj-abcdefghijklmnop1234567890',
        'Anthropic key': 'sk-ant-api03-abcdefghijklmnop',
        'GitHub token': 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        'GitHub server token': 'ghs_abcdefghijklmnopqrstuvwxyz0123456789',
        'GitHub fine-grained token': 'github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz',
        'Slack bot token': 'xoxb-1234567890-abcdefghij',
        'Slack app token': 'xapp-1-A0123-4567-abcdef',
        'JWT': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
    };

    it.each(Object.entries(tokens))('redacts a %s', (_name, token) => {
        const text = redact(`before ${token} after`, []);
        expect(text).not.toContain(token);
        expect(text).toBe(`before ${REDACTED} after`);
    });

    it('redacts bearer headers, keeping the surrounding text', () => {
        expect(redact('curl -H "Authorization: Bearer abc.DEF-123_456~xyz=" https://x', [])).toBe(`curl -H "Authorization: ${REDACTED}" https://x`);
        expect(redact('authorization: bearer sometokenvalue1', [])).toBe(`authorization: ${REDACTED}`);
    });

    it('redacts a private key block, also when it is cut off', () => {
        const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
        expect(redact(`key: ${pem} done`, [])).toBe(`key: ${REDACTED} done`);
        expect(redact('-----BEGIN PRIVATE KEY-----\nMIIEv', [])).toBe(REDACTED);
    });

    it('redacts the values of configured secrets, longest first, everywhere they appear', () => {
        const env = { JWT_SECRET: 'super-secret-signing-key-value', GITHUB_APP_PRIVATE_KEY: 'pem-body-123', EXECUTOR_SECRET_KEY: 'k'.repeat(32), SHORT_TOKEN: 'abc', PLAIN: 'visible-value-12345', DATABASE_PASSWORD: 'super-secret-signing-key-value-extended' };
        const secrets = configuredSecrets(env);
        expect(secrets).not.toContain('abc'); // too short to match without eating ordinary words
        expect(secrets).not.toContain('visible-value-12345');
        const text = redact(`a super-secret-signing-key-value b super-secret-signing-key-value-extended c ${'k'.repeat(32)} d pem-body-123`, secrets);
        expect(text).toBe(`a ${REDACTED} b ${REDACTED} c ${REDACTED} d ${REDACTED}`);
    });

    it('keeps ordinary text', () => {
        const text = 'Job 5d571258-6279 failed: skeleton task-1 ghp is not a token, sk is short';
        expect(redact(text, [])).toBe(text);
    });
});

describe('redactAndCap', () => {
    it('redacts before capping, so a secret cut by the cap leaves no readable prefix', () => {
        const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
        const text = `${'x'.repeat(95)}${secret}`;
        const out = redactAndCap(text, 100, []);
        expect(out).not.toContain('ghp_');
        // The marker, not the token, is what the cap cuts.
        expect(out.startsWith(`${'x'.repeat(95)}${REDACTED.slice(0, 5)}`)).toBe(true);
    });

    it('caps and says how much was cut', () => {
        const out = redactAndCap('a'.repeat(300), 100, []);
        expect(out.startsWith('a'.repeat(100))).toBe(true);
        expect(out).toContain('truncated, 200 more characters');
        expect(redactAndCap('short', 100, [])).toBe('short');
    });

    it('serializes objects and never throws on odd values', () => {
        expect(redactAndCap({ token: 'sk-abcdefghijklmnop', n: 1 }, 100, [])).toBe(`{"token":"${REDACTED}","n":1}`);
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(textOf(cyclic)).toBe('[unserializable]');
        expect(textOf(undefined)).toBe('');
        expect(textOf(10n)).toBe('[unserializable]');
    });
});
