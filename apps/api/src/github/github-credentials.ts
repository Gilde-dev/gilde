import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

const API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;
/** An installation token is replaced this long before it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** App JWTs live 9 minutes (GitHub allows 10) and start 60 seconds in the past to absorb clock drift. */
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 540;

export type GitHubMode = 'app' | 'pat' | 'none';

interface CachedToken {
    token: string;
    expiresAt: number;
}

/**
 * The only place that reads GITHUB_TOKEN, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_APP_INSTALLATION_ID.
 * Mode is decided when the service is constructed (startup): `app` with an app id and key, else `pat` with GITHUB_TOKEN,
 * else `none`. Half an app config or an unparseable key throws, naming the variable and never its value.
 * Installation tokens live in memory only, are cached per installation and are never logged or put in errors.
 */
@Injectable()
export class GitHubCredentials implements OnModuleInit {
    private readonly logger = new Logger(GitHubCredentials.name);
    readonly mode: GitHubMode;
    private readonly pat: string | null;
    private readonly appId: string | null = null;
    private readonly key: KeyObject | null = null;
    private readonly fixedInstallation: string | null;
    private readonly installations = new Map<string, string>();
    private readonly tokens = new Map<string, CachedToken>();
    private readonly inflight = new Map<string, Promise<CachedToken>>();

    constructor() {
        const appId = process.env.GITHUB_APP_ID?.trim();
        const rawKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
        this.pat = process.env.GITHUB_TOKEN?.trim() || null;
        this.fixedInstallation = process.env.GITHUB_APP_INSTALLATION_ID?.trim() || null;
        if (!!appId !== !!rawKey) {
            throw new Error(`${appId ? 'GITHUB_APP_PRIVATE_KEY' : 'GITHUB_APP_ID'} is not set; GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set together`);
        }
        if (appId && rawKey) {
            this.appId = appId;
            this.key = parseKey(rawKey);
            this.mode = 'app';
        } else {
            this.mode = this.pat ? 'pat' : 'none';
        }
    }

    onModuleInit(): void {
        this.logger.log(
            this.mode === 'app' ? 'GitHub credentials: GitHub App (installation tokens)'
                : this.mode === 'pat' ? 'GitHub credentials: personal access token (GITHUB_TOKEN)'
                    : 'GitHub credentials: not configured',
        );
    }

    isConfigured(): boolean {
        return this.mode !== 'none';
    }

    /** Whether `id` is this app's id (the `performed_via_github_app` of a comment): its own writes are never input. */
    isOwnApp(id: number | string | null | undefined): boolean {
        return this.appId !== null && id !== null && id !== undefined && String(id) === this.appId;
    }

    /** A token for API and git access to `fullName` ("owner/repo"). */
    async tokenFor(fullName: string): Promise<string> {
        if (this.mode === 'pat') return this.pat as string;
        if (this.mode === 'none') throw new Error('GitHub is not configured (GITHUB_TOKEN or GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)');
        const id = await this.installationId(fullName);
        const cached = this.tokens.get(id);
        if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return cached.token;
        let pending = this.inflight.get(id);
        if (!pending) {
            pending = this.createToken(id).then((t) => {
                this.tokens.set(id, t);
                return t;
            }).finally(() => this.inflight.delete(id));
            this.inflight.set(id, pending);
        }
        return (await pending).token;
    }

    /** The app JWT (RS256). Exposed for tests; callers use `tokenFor`. */
    appJwt(now = Date.now()): string {
        const iat = Math.floor(now / 1000) - JWT_BACKDATE_S;
        const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
        const body = b64url(JSON.stringify({ iat, exp: iat + JWT_BACKDATE_S + JWT_LIFETIME_S, iss: this.appId }));
        const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), this.key as KeyObject);
        return `${head}.${body}.${sig.toString('base64url')}`;
    }

    private async installationId(fullName: string): Promise<string> {
        if (this.fixedInstallation) return this.fixedInstallation;
        const known = this.installations.get(fullName);
        if (known) return known;
        const res = await this.appRequest(`/repos/${fullName}/installation`, 'GET');
        if (res.status === 404) throw new Error(`the Gilde GitHub App is not installed on ${fullName}`);
        if (!res.ok) throw new Error(`GitHub GET /repos/${fullName}/installation failed: ${res.status}`);
        const id = String(((await res.json()) as { id: number }).id);
        this.installations.set(fullName, id);
        return id;
    }

    private async createToken(installationId: string): Promise<CachedToken> {
        const path = `/app/installations/${encodeURIComponent(installationId)}/access_tokens`;
        const res = await this.appRequest(path, 'POST');
        if (!res.ok) throw new Error(`GitHub POST /app/installations/:id/access_tokens failed: ${res.status}`);
        const body = (await res.json()) as { token: string; expires_at: string };
        return { token: body.token, expiresAt: Date.parse(body.expires_at) };
    }

    private appRequest(path: string, method: 'GET' | 'POST'): Promise<Response> {
        return fetch(`${API}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${this.appJwt()}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    }
}

const b64url = (s: string): string => Buffer.from(s).toString('base64url');

/** PEM, or base64 of a PEM (env files cannot hold line breaks; literal `\n` is accepted too). Never echoes the value. */
function parseKey(raw: string): KeyObject {
    const bad = () => new Error('GITHUB_APP_PRIVATE_KEY is not a valid RSA private key (PEM or base64-encoded PEM)');
    let pem = raw.replace(/\\n/g, '\n');
    if (!pem.includes('-----BEGIN')) pem = Buffer.from(raw, 'base64').toString('utf8');
    if (!pem.includes('-----BEGIN')) throw bad();
    try {
        const key = createPrivateKey(pem);
        if (key.asymmetricKeyType !== 'rsa') throw bad();
        return key;
    } catch {
        throw bad();
    }
}
