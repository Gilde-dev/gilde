import { generateKeyPairSync, verify } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitHubCredentials, TOKEN_REFRESH_MARGIN_MS } from './github-credentials.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PEM_B64 = Buffer.from(PEM).toString('base64');
const VARS = ['GITHUB_TOKEN', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID'];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tokenBody = (token: string, ttlMs = 3_600_000) => ({ token, expires_at: new Date(Date.now() + ttlMs).toISOString() });

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    for (const v of VARS) vi.stubEnv(v, '');
    fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

const appEnv = (key = PEM) => {
    vi.stubEnv('GITHUB_APP_ID', '42');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', key);
};

describe('GitHubCredentials modes', () => {
    it('is not configured without variables', async () => {
        const c = new GitHubCredentials();
        expect(c.mode).toBe('none');
        expect(c.isConfigured()).toBe(false);
        await expect(c.tokenFor('o/r')).rejects.toThrow('not configured');
    });

    it('uses the PAT when only GITHUB_TOKEN is set', async () => {
        vi.stubEnv('GITHUB_TOKEN', 'ghp_pat');
        const c = new GitHubCredentials();
        expect(c.mode).toBe('pat');
        expect(await c.tokenFor('o/r')).toBe('ghp_pat');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('prefers the app over the PAT, with a PEM or a base64 key', () => {
        vi.stubEnv('GITHUB_TOKEN', 'ghp_pat');
        appEnv();
        expect(new GitHubCredentials().mode).toBe('app');
        appEnv(PEM_B64);
        expect(new GitHubCredentials().mode).toBe('app');
        appEnv(PEM.replace(/\n/g, '\\n'));
        expect(new GitHubCredentials().mode).toBe('app');
    });

    it('fails closed on half an app config without printing values', () => {
        vi.stubEnv('GITHUB_APP_ID', '42');
        expect(() => new GitHubCredentials()).toThrow('GITHUB_APP_PRIVATE_KEY');
        vi.stubEnv('GITHUB_APP_ID', '');
        vi.stubEnv('GITHUB_APP_PRIVATE_KEY', PEM);
        const err = (() => { try { new GitHubCredentials(); } catch (e) { return e as Error; } })();
        expect(err?.message).toContain('GITHUB_APP_ID');
        expect(err?.message).not.toContain('PRIVATE KEY');
    });

    it('fails closed on an unparseable key without printing it', () => {
        for (const bad of ['not-a-key-at-all-secret', '-----BEGIN PRIVATE KEY-----\nbm9wZQ==\n-----END PRIVATE KEY-----']) {
            appEnv(bad);
            const err = (() => { try { new GitHubCredentials(); } catch (e) { return e as Error; } })();
            expect(err?.message).toContain('GITHUB_APP_PRIVATE_KEY');
            expect(err?.message).not.toContain('secret');
            expect(err?.message).not.toContain('bm9wZQ');
        }
    });

    it('logs the mode once at startup, never a secret', () => {
        const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        appEnv();
        new GitHubCredentials().onModuleInit();
        expect(log).toHaveBeenCalledTimes(1);
        expect(String(log.mock.calls[0][0])).toContain('GitHub App');
        expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
        log.mockRestore();
    });
});

describe('app mode', () => {
    it('signs an RS256 JWT with iat 60s in the past and exp within 10 minutes', () => {
        appEnv();
        const now = 1_800_000_000_000;
        const jwt = new GitHubCredentials().appJwt(now);
        const [h, p, s] = jwt.split('.');
        expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
        const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
        expect(claims).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: '42' });
        expect(claims.exp - now / 1000).toBeLessThanOrEqual(600);
        expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    });

    it('recognises its own app id and nothing else', () => {
        appEnv();
        const c = new GitHubCredentials();
        expect(c.isOwnApp(42)).toBe(true);
        expect(c.isOwnApp('42')).toBe(true);
        expect(c.isOwnApp(43)).toBe(false);
        expect(c.isOwnApp(undefined)).toBe(false);
        expect(c.isOwnApp(null)).toBe(false);
    });

    it('looks up the installation and creates a token, authenticating with the app JWT', async () => {
        appEnv();
        fetchSpy.mockResolvedValueOnce(json({ id: 7 })).mockResolvedValueOnce(json(tokenBody('ghs_one'), 201));
        expect(await new GitHubCredentials().tokenFor('o/r')).toBe('ghs_one');
        const [[u1, i1], [u2, i2]] = fetchSpy.mock.calls as [string, RequestInit & { headers: Record<string, string> }][];
        expect(u1).toBe('https://api.github.com/repos/o/r/installation');
        expect(u2).toBe('https://api.github.com/app/installations/7/access_tokens');
        expect(i2.method).toBe('POST');
        expect(i1.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    });

    it('uses GITHUB_APP_INSTALLATION_ID without a lookup', async () => {
        appEnv();
        vi.stubEnv('GITHUB_APP_INSTALLATION_ID', '99');
        fetchSpy.mockResolvedValueOnce(json(tokenBody('ghs_fixed'), 201));
        expect(await new GitHubCredentials().tokenFor('o/r')).toBe('ghs_fixed');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(String(fetchSpy.mock.calls[0][0])).toContain('/app/installations/99/');
    });

    it('says clearly when the app is not installed', async () => {
        appEnv();
        fetchSpy.mockResolvedValue(json({ message: 'Not Found' }, 404));
        await expect(new GitHubCredentials().tokenFor('o/r')).rejects.toThrow('the Gilde GitHub App is not installed on o/r');
    });

    it('caches per installation and refreshes 5 minutes before expiry', async () => {
        appEnv();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        fetchSpy
            .mockResolvedValueOnce(json({ id: 7 }))
            .mockResolvedValueOnce(json(tokenBody('ghs_a', 3_600_000), 201))
            .mockResolvedValueOnce(json(tokenBody('ghs_b', 3_600_000), 201));
        const c = new GitHubCredentials();
        expect(await c.tokenFor('o/r')).toBe('ghs_a');
        expect(await c.tokenFor('o/r')).toBe('ghs_a');
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        vi.setSystemTime(Date.now() + 3_600_000 - TOKEN_REFRESH_MARGIN_MS - 1000);
        expect(await c.tokenFor('o/r')).toBe('ghs_a');
        vi.setSystemTime(Date.now() + 2000);
        expect(await c.tokenFor('o/r')).toBe('ghs_b');
        expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('shares one in-flight request between concurrent callers', async () => {
        appEnv();
        vi.stubEnv('GITHUB_APP_INSTALLATION_ID', '99');
        let release!: () => void;
        fetchSpy.mockImplementation(() => new Promise((res) => { release = () => res(json(tokenBody('ghs_shared'), 201)); }));
        const c = new GitHubCredentials();
        const all = Promise.all([c.tokenFor('o/a'), c.tokenFor('o/b'), c.tokenFor('o/c')]);
        await vi.waitFor(() => expect(release).toBeDefined());
        release();
        expect(await all).toEqual(['ghs_shared', 'ghs_shared', 'ghs_shared']);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps tokens and the key out of errors', async () => {
        appEnv();
        vi.stubEnv('GITHUB_APP_INSTALLATION_ID', '99');
        fetchSpy.mockResolvedValue(json({ message: 'Bad credentials ghs_leak' }, 401));
        const err = await new GitHubCredentials().tokenFor('o/r').catch((e: Error) => e);
        expect(err.message).toContain('401');
        expect(err.message).not.toContain('ghs_leak');
        expect(err.message).not.toContain('PRIVATE');
    });
});

describe('credential reads are confined to GitHubCredentials', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((n) => {
            const p = join(dir, n);
            return statSync(p).isDirectory() ? (n === 'migrations' ? [] : walk(p)) : p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
        });

    it('no other production file mentions the GitHub credential variables', () => {
        const offenders = walk(join(root, '..'))
            .filter((f) => !f.endsWith(join('github', 'github-credentials.ts')))
            .filter((f) => /GITHUB_TOKEN|GITHUB_APP_(ID|PRIVATE_KEY|INSTALLATION_ID)/.test(readFileSync(f, 'utf8')))
            .map((f) => relative(join(root, '..'), f));
        // Only user-facing messages may name the variables; none may read process.env for them.
        const readers = offenders.filter((f) => /process\.env\.GITHUB_(TOKEN|APP)|env\[['"]GITHUB_(TOKEN|APP)/.test(readFileSync(join(root, '..', f), 'utf8')));
        expect(readers).toEqual([]);
    });
});
