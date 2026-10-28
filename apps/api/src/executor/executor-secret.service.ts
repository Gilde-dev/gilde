import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const EXECUTOR_KEY_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface EncryptedToken {
    ciphertext: string;
    iv: string;
    tag: string;
    keyVersion: number;
}

/**
 * Parses EXECUTOR_SECRET_KEY (base64, exactly 32 bytes). Returns null when unset; throws when set but malformed, so the API
 * fails closed at startup. The message never contains the value.
 */
export function parseExecutorSecretKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
    const raw = env.EXECUTOR_SECRET_KEY?.trim();
    if (!raw) return null;
    const key = BASE64.test(raw) && raw.length % 4 === 0 ? Buffer.from(raw, 'base64') : null;
    if (!key || key.length !== KEY_BYTES) {
        throw new Error(`EXECUTOR_SECRET_KEY must be base64 of exactly ${KEY_BYTES} bytes (e.g. \`openssl rand -base64 32\`).`);
    }
    return key;
}

/** AES-256-GCM encryption of routine tokens. Plaintext and key never leave this class except as the decrypted token. */
@Injectable()
export class ExecutorSecretService {
    private readonly key: Buffer | null;

    constructor() {
        this.key = parseExecutorSecretKey();
    }

    isConfigured(): boolean {
        return this.key !== null;
    }

    /** 503 with a clear message when EXECUTOR_SECRET_KEY is not set. */
    assertConfigured(): void {
        this.requireKey();
    }

    encrypt(plaintext: string): EncryptedToken {
        const key = this.requireKey();
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        return {
            ciphertext: ciphertext.toString('base64'),
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            keyVersion: EXECUTOR_KEY_VERSION,
        };
    }

    /** Internal: for the dispatcher only, never behind a route. Throws a generic error when the data was tampered with or the key differs. */
    decrypt(encrypted: EncryptedToken): string {
        const key = this.requireKey();
        if (encrypted.keyVersion !== EXECUTOR_KEY_VERSION) throw new Error(`Unsupported executor key version ${encrypted.keyVersion}`);
        try {
            const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'), { authTagLength: TAG_BYTES });
            decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
            return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]).toString('utf8');
        } catch {
            throw new Error('Executor token could not be decrypted');
        }
    }

    private requireKey(): Buffer {
        if (!this.key) {
            throw new ServiceUnavailableException('Executors are not configured: set EXECUTOR_SECRET_KEY on the server (openssl rand -base64 32)');
        }
        return this.key;
    }
}
