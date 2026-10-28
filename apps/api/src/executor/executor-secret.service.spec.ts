import { randomBytes } from 'node:crypto';

import { ServiceUnavailableException } from '@nestjs/common';

import { EXECUTOR_KEY_VERSION, ExecutorSecretService, parseExecutorSecretKey } from './executor-secret.service.js';

const keyB64 = () => randomBytes(32).toString('base64');

describe('ExecutorSecretService', () => {
    const previous = process.env.EXECUTOR_SECRET_KEY;
    afterEach(() => {
        if (previous === undefined) delete process.env.EXECUTOR_SECRET_KEY;
        else process.env.EXECUTOR_SECRET_KEY = previous;
    });

    const withKey = (key: string | undefined) => {
        if (key === undefined) delete process.env.EXECUTOR_SECRET_KEY;
        else process.env.EXECUTOR_SECRET_KEY = key;
        return new ExecutorSecretService();
    };

    it('round-trips a token with a random IV per write and never stores it in clear', () => {
        const service = withKey(keyB64());
        const a = service.encrypt('sk-secret-token');
        const b = service.encrypt('sk-secret-token');
        expect(a.keyVersion).toBe(EXECUTOR_KEY_VERSION);
        expect(Buffer.from(a.iv, 'base64')).toHaveLength(12);
        expect(a.iv).not.toBe(b.iv);
        expect(a.ciphertext).not.toBe(b.ciphertext);
        expect(JSON.stringify(a)).not.toContain('sk-secret-token');
        expect(service.decrypt(a)).toBe('sk-secret-token');
        expect(service.decrypt(b)).toBe('sk-secret-token');
    });

    it('detects tampering with the ciphertext, the tag or the IV', () => {
        const service = withKey(keyB64());
        const enc = service.encrypt('sk-secret-token');
        const flip = (b64: string) => {
            const buf = Buffer.from(b64, 'base64');
            buf[0] ^= 0xff;
            return buf.toString('base64');
        };
        expect(() => service.decrypt({ ...enc, ciphertext: flip(enc.ciphertext) })).toThrow('could not be decrypted');
        expect(() => service.decrypt({ ...enc, tag: flip(enc.tag) })).toThrow('could not be decrypted');
        expect(() => service.decrypt({ ...enc, iv: flip(enc.iv) })).toThrow('could not be decrypted');
    });

    it('cannot decrypt with another key, and the error does not leak the token', () => {
        const enc = withKey(keyB64()).encrypt('sk-secret-token');
        const other = withKey(keyB64());
        expect(() => other.decrypt(enc)).toThrow('Executor token could not be decrypted');
        expect(() => other.decrypt({ ...enc, keyVersion: 2 })).toThrow('Unsupported executor key version');
    });

    it('is unconfigured without a key: 503 on encrypt, but the service still constructs', () => {
        const service = withKey(undefined);
        expect(service.isConfigured()).toBe(false);
        expect(() => service.encrypt('x')).toThrow(ServiceUnavailableException);
        expect(() => service.assertConfigured()).toThrow(/EXECUTOR_SECRET_KEY/);
        expect(withKey('   ').isConfigured()).toBe(false);
    });

    it.each([
        ['not base64', 'not base64 at all!!'],
        ['too short', randomBytes(16).toString('base64')],
        ['too long', randomBytes(33).toString('base64')],
        ['hex of 32 bytes', randomBytes(32).toString('hex')],
    ])('fails closed on a malformed key (%s) without echoing it', (_label, bad) => {
        expect(() => parseExecutorSecretKey({ EXECUTOR_SECRET_KEY: bad })).toThrow(/base64 of exactly 32 bytes/);
        try {
            withKey(bad);
        } catch (e) {
            expect((e as Error).message).not.toContain(bad);
        }
    });

    it('accepts a valid key', () => {
        expect(parseExecutorSecretKey({ EXECUTOR_SECRET_KEY: keyB64() })).toHaveLength(32);
    });
});
