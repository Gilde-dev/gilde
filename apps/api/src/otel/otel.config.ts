import { createHash, timingSafeEqual } from 'node:crypto';

export const MIN_OTEL_INGEST_TOKEN_LENGTH = 32;
export const DEFAULT_OTEL_RATE_LIMIT = 120;
export const OTEL_RATE_TTL_MS = 60_000;
export const OTEL_MAX_BODY = '5mb';

export type OtelIngestConfig =
    | { state: 'enabled'; token: string }
    | { state: 'disabled' }
    | { state: 'invalid'; reason: string };

/**
 * OTEL_INGEST_TOKEN decides whether the OTLP routes exist. Unset: disabled (404). Set but unusable (shorter than
 * 32 characters, or shaped like a Gilde API key): invalid, which behaves like disabled and is warned about at startup.
 * The reason never contains the value.
 */
export function otelIngestConfig(env: NodeJS.ProcessEnv = process.env): OtelIngestConfig {
    const token = env.OTEL_INGEST_TOKEN?.trim();
    if (!token) return { state: 'disabled' };
    if (token.length < MIN_OTEL_INGEST_TOKEN_LENGTH) {
        return { state: 'invalid', reason: `OTEL_INGEST_TOKEN is shorter than ${MIN_OTEL_INGEST_TOKEN_LENGTH} characters` };
    }
    if (token.startsWith('gk_')) {
        return { state: 'invalid', reason: 'OTEL_INGEST_TOKEN must not look like a Gilde API key (gk_ prefix)' };
    }
    return { state: 'enabled', token };
}

/** Requests per client address per route per minute (OTEL_INGEST_RATE_LIMIT, default 120). */
export function otelRateLimit(env: NodeJS.ProcessEnv = process.env): number {
    const n = Number(env.OTEL_INGEST_RATE_LIMIT);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_OTEL_RATE_LIMIT;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** True when the Authorization header carries the configured ingest token. Compares fixed-length sha256 digests in constant time. */
export function hasValidIngestToken(authorization: string | undefined, config: OtelIngestConfig): boolean {
    if (config.state !== 'enabled') return false;
    const provided = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1] ?? '';
    return timingSafeEqual(digest(provided), digest(config.token)) && provided.length > 0;
}

export function isJsonContentType(contentType: string | undefined): boolean {
    return /^application\/json\s*(;.*)?$/i.test(contentType?.trim() ?? '');
}

/** The two ingest paths below the global prefix; matched case-insensitively and without a trailing slash like express routing. */
export function isOtelIngestPath(path: string, globalPrefix = '/api'): boolean {
    const normalized = path.toLowerCase().replace(/\/+$/, '');
    return normalized === `${globalPrefix}/v1/otel/v1/logs` || normalized === `${globalPrefix}/v1/otel/v1/metrics`;
}
