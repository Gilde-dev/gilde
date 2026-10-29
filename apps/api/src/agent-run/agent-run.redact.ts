/**
 * Redaction of recorded text, applied before capping so a secret cut in half by the cap is never left as a readable prefix.
 * Known token formats are matched by shape; the values of configured secrets (see SECRET_ENV_PATTERN) are matched exactly.
 */
// Distinctive prefixes are matched anywhere (a secret glued to other text is still a secret); `sk-` needs a word boundary, or "task-..." would match.
const PATTERNS: RegExp[] = [
    /gk_[A-Za-z0-9_-]{6,}/g, // Gilde API keys: gk_<prefix>_<secret>
    /\bsk-[A-Za-z0-9_-]{8,}/g, // OpenAI / Anthropic style keys (sk-proj-..., sk-ant-...)
    /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}/g, // GitHub tokens
    /github_pat_[A-Za-z0-9_]{10,}/g,
    /xox[abprs]-[A-Za-z0-9-]{6,}/g, // Slack tokens
    /xapp-[A-Za-z0-9-]{6,}/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, // Authorization headers
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWTs
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/** Environment variables whose values are secrets: any name containing one of these words. */
const SECRET_ENV_PATTERN = /(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|WEBHOOK_SECRET)/i;
const MIN_SECRET_LENGTH = 8;
export const REDACTED = '[redacted]';

/** The values of the configured secrets that are long enough to be matched without redacting ordinary words. */
export function configuredSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
    const values = new Set<string>();
    for (const [name, value] of Object.entries(env)) {
        if (value && SECRET_ENV_PATTERN.test(name) && value.length >= MIN_SECRET_LENGTH) values.add(value);
    }
    // Longest first, so a secret that contains another one is replaced as a whole.
    return [...values].sort((a, b) => b.length - a.length);
}

export function redact(text: string, secrets: readonly string[] = configuredSecrets()): string {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join(REDACTED);
    for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
    return out;
}

/** Text of any value: strings as they are, everything else as JSON (never throws; unserializable values become a note). */
export function textOf(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined) return '';
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return '[unserializable]';
    }
}

/** Redacts first, then caps, so a secret is never left half visible at the cap. */
export function redactAndCap(value: unknown, max: number, secrets?: readonly string[]): string {
    const clean = redact(textOf(value), secrets);
    return clean.length > max ? `${clean.slice(0, max)}… [truncated, ${clean.length - max} more characters]` : clean;
}
