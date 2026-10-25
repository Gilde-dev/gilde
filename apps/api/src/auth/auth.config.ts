import { randomBytes } from 'node:crypto';

export const MIN_JWT_SECRET_LENGTH = 32;
export const DEFAULT_JWT_EXPIRES_IN = '12h';

export function authEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const value = env.AUTH_ENABLED?.trim().toLowerCase();
    return value !== 'false' && value !== '0';
}

/** Throws a clear error when auth is on and JWT_SECRET is missing or too short. */
export function assertAuthConfig(env: NodeJS.ProcessEnv = process.env): void {
    if (!authEnabled(env)) return;
    const secret = env.JWT_SECRET;
    if (!secret || secret.length < MIN_JWT_SECRET_LENGTH) {
        throw new Error(
            `JWT_SECRET must be set to at least ${MIN_JWT_SECRET_LENGTH} characters (e.g. \`openssl rand -base64 48\`), ` +
            'or set AUTH_ENABLED=false to run the API without authentication.',
        );
    }
}

let ephemeralSecret: string | undefined;

/** The signing secret. With auth disabled and no secret set, a random per-process one is used. */
export function jwtSecret(env: NodeJS.ProcessEnv = process.env): string {
    assertAuthConfig(env);
    if (env.JWT_SECRET) return env.JWT_SECRET;
    ephemeralSecret ??= randomBytes(48).toString('base64');
    return ephemeralSecret;
}

export function jwtExpiresIn(env: NodeJS.ProcessEnv = process.env): string {
    return env.JWT_EXPIRES_IN?.trim() || DEFAULT_JWT_EXPIRES_IN;
}
