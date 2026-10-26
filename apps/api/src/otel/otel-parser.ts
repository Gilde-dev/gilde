import { createHash } from 'node:crypto';

/**
 * Decoder for OTLP/HTTP JSON export requests. It reads an explicit allowlist of attributes of
 * `claude_code.api_request` log records and nothing else: prompts, tool input/output, emails, resource blobs and
 * unknown attributes are never read, so they cannot be stored or logged.
 */

export const API_REQUEST_EVENT = 'claude_code.api_request';
const API_REQUEST_NAMES = new Set([API_REQUEST_EVENT, 'api_request']);

export const MAX_TOKENS = 2_147_483_647;
const MAX_NS = 253_402_300_800n * 1_000_000_000n; // year 10000
const MAX_ID_LENGTH = 256;
const MAX_META_LENGTH = 128;

/** Attribute names (documented dotted form first, then snake_case and camelCase variants) per accounting field. */
export const ATTRIBUTE_ALIASES = {
    eventName: ['event.name', 'event_name', 'eventName'],
    eventTimestamp: ['event.timestamp', 'event_timestamp', 'eventTimestamp'],
    sequence: ['event.sequence', 'event_sequence', 'eventSequence'],
    sessionId: ['session.id', 'session_id', 'sessionId'],
    model: ['model'],
    inputTokens: ['input_tokens', 'inputTokens'],
    outputTokens: ['output_tokens', 'outputTokens'],
    cacheReadTokens: ['cache_read_tokens', 'cacheReadTokens'],
    cacheCreationTokens: ['cache_creation_tokens', 'cacheCreationTokens'],
    costUsd: ['cost_usd', 'costUsd'],
    durationMs: ['duration_ms', 'durationMs'],
    organizationId: ['organization.id', 'organization_id', 'organizationId'],
} as const;
const SERVICE_VERSION_ALIASES = ['service.version', 'service_version'] as const;

export interface ParsedAgentUsage {
    eventKey: string;
    sessionId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number | null;
    durationMs: number | null;
    eventAt: Date;
    serviceVersion: string | null;
    organizationId: string | null;
}

export interface ParsedLogs {
    records: ParsedAgentUsage[];
    /** api_request records (or non-object records) that failed validation; reported as partialSuccess.rejectedLogRecords. */
    rejected: number;
}

/** The request is not a well-formed OTLP envelope (HTTP 400). */
export class OtlpEnvelopeError extends Error { }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function list(parent: Obj, key: string, what: string): Obj[] {
    const value = parent[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new OtlpEnvelopeError(`${what} must be an array`);
    return value as Obj[];
}

function envelope(body: unknown, what: string): Obj {
    if (!isObj(body)) throw new OtlpEnvelopeError(`${what} request body must be a JSON object`);
    return body;
}

/** key -> AnyValue for the keys in the allowlist only. */
function pick(attributes: unknown, allowed: ReadonlySet<string>): Map<string, Obj> {
    const out = new Map<string, Obj>();
    if (!Array.isArray(attributes)) return out;
    for (const kv of attributes) {
        if (!isObj(kv) || typeof kv.key !== 'string' || !allowed.has(kv.key) || !isObj(kv.value)) continue;
        if (!out.has(kv.key)) out.set(kv.key, kv.value);
    }
    return out;
}

const RECORD_KEYS = new Set<string>(Object.values(ATTRIBUTE_ALIASES).flat());
const RESOURCE_KEYS = new Set<string>([...SERVICE_VERSION_ALIASES, ...ATTRIBUTE_ALIASES.organizationId]);

function lookup(attrs: Map<string, Obj>, aliases: readonly string[]): Obj | undefined {
    for (const a of aliases) {
        const v = attrs.get(a);
        if (v) return v;
    }
    return undefined;
}

// --- typed AnyValue readers; each returns undefined when absent and throws Invalid when present but wrong ---
class Invalid extends Error { }

function readString(v: Obj | undefined, max: number): string | undefined {
    if (!v) return undefined;
    const s = v.stringValue;
    if (typeof s !== 'string') throw new Invalid();
    const t = s.trim();
    // eslint-disable-next-line no-control-regex
    if (t.length === 0 || t.length > max || /[\u0000-\u001f\u007f]/.test(t)) throw new Invalid();
    return t;
}

function readNumber(v: Obj | undefined): number | undefined {
    if (!v) return undefined;
    let raw: unknown;
    if ('intValue' in v) raw = v.intValue;
    else if ('doubleValue' in v) raw = v.doubleValue;
    else if ('stringValue' in v) raw = v.stringValue; // exporters that stringify numbers
    else throw new Invalid();
    if (typeof raw === 'string') {
        if (!/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw.trim())) throw new Invalid();
        raw = Number(raw);
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) throw new Invalid();
    return raw;
}

function readCount(v: Obj | undefined): number | undefined {
    const n = readNumber(v);
    if (n === undefined) return undefined;
    if (!Number.isSafeInteger(n) || n > MAX_TOKENS) throw new Invalid();
    return n;
}

/** Unix nanoseconds as a decimal string (or integer number) -> exact BigInt. Never goes through a float for strings. */
function parseNanos(raw: unknown): bigint | undefined {
    if (raw === undefined || raw === null) return undefined;
    let ns: bigint;
    if (typeof raw === 'string' && /^\d{1,20}$/.test(raw)) ns = BigInt(raw);
    else if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) ns = BigInt(raw);
    else throw new Invalid();
    return ns;
}

function parseEventAt(rec: Obj, attrs: Map<string, Obj>): { ns: string; at: Date } {
    let ns = parseNanos(rec.timeUnixNano);
    if (ns === undefined || ns === 0n) {
        // Documented ISO event.timestamp attribute (millisecond precision) when the record has no time.
        const iso = readString(lookup(attrs, ATTRIBUTE_ALIASES.eventTimestamp), 64);
        const ms = iso ? Date.parse(iso) : NaN;
        if (!Number.isFinite(ms) || ms <= 0) throw new Invalid();
        ns = BigInt(ms) * 1_000_000n;
    }
    if (ns <= 0n || ns >= MAX_NS) throw new Invalid();
    return { ns: ns.toString(), at: new Date(Number(ns / 1_000_000n)) };
}

/**
 * Stable per-event key. With the documented producer sequence (`event.sequence`): session + full-precision time +
 * sequence. Without it: session + time + a fingerprint of the allowlisted accounting fields, so rebatching and retries
 * give the same key and distinct records with equal timestamps stay distinct. Two records identical in every allowlisted
 * field, same session and same nanosecond, and without a sequence, are indistinguishable and count once.
 * No request arrival time, random id or batch position goes into it.
 */
function eventKey(u: Omit<ParsedAgentUsage, 'eventKey'>, ns: string, sequence: number | undefined): string {
    const discriminator = sequence !== undefined
        ? `seq:${sequence}`
        : `fp:${JSON.stringify([u.model, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheCreationTokens, u.costUsd, u.durationMs])}`;
    return createHash('sha256').update(`v1\n${u.sessionId}\n${ns}\n${discriminator}`).digest('hex');
}

function eventNames(rec: Obj, attrs: Map<string, Obj>): string[] {
    const names: unknown[] = [rec.eventName, lookup(attrs, ATTRIBUTE_ALIASES.eventName)?.stringValue];
    // The body only counts when it is exactly the event name; it is never parsed for anything else.
    if (isObj(rec.body)) names.push(rec.body.stringValue);
    return names.filter((n): n is string => typeof n === 'string');
}

function toUsage(rec: Obj, attrs: Map<string, Obj>, resource: Map<string, Obj>): ParsedAgentUsage {
    const sessionId = readString(lookup(attrs, ATTRIBUTE_ALIASES.sessionId), MAX_ID_LENGTH);
    const model = readString(lookup(attrs, ATTRIBUTE_ALIASES.model), MAX_ID_LENGTH);
    if (!sessionId || !model) throw new Invalid();
    const { ns, at } = parseEventAt(rec, attrs);
    const sequence = readCount(lookup(attrs, ATTRIBUTE_ALIASES.sequence));

    const meta = (v: Obj | undefined): string | null => {
        try { return readString(v, MAX_META_LENGTH) ?? null; } catch { return null; }
    };
    const base = {
        sessionId,
        model,
        inputTokens: readCount(lookup(attrs, ATTRIBUTE_ALIASES.inputTokens)) ?? 0,
        outputTokens: readCount(lookup(attrs, ATTRIBUTE_ALIASES.outputTokens)) ?? 0,
        cacheReadTokens: readCount(lookup(attrs, ATTRIBUTE_ALIASES.cacheReadTokens)) ?? 0,
        cacheCreationTokens: readCount(lookup(attrs, ATTRIBUTE_ALIASES.cacheCreationTokens)) ?? 0,
        costUsd: readNumber(lookup(attrs, ATTRIBUTE_ALIASES.costUsd)) ?? null,
        durationMs: readNumber(lookup(attrs, ATTRIBUTE_ALIASES.durationMs)) ?? null,
        eventAt: at,
        serviceVersion: meta(lookup(resource, SERVICE_VERSION_ALIASES)),
        organizationId: meta(lookup(resource, ATTRIBUTE_ALIASES.organizationId) ?? lookup(attrs, ATTRIBUTE_ALIASES.organizationId)),
    };
    return { ...base, eventKey: eventKey(base, ns, sequence) };
}

/** Decodes an ExportLogsServiceRequest. Throws OtlpEnvelopeError for a malformed envelope. */
export function parseOtlpLogs(body: unknown): ParsedLogs {
    const root = envelope(body, 'logs');
    const records: ParsedAgentUsage[] = [];
    let rejected = 0;
    for (const rl of list(root, 'resourceLogs', 'resourceLogs')) {
        if (!isObj(rl)) throw new OtlpEnvelopeError('resourceLogs entries must be objects');
        const resource = pick(isObj(rl.resource) ? rl.resource.attributes : undefined, RESOURCE_KEYS);
        for (const sl of list(rl, 'scopeLogs', 'scopeLogs')) {
            if (!isObj(sl)) throw new OtlpEnvelopeError('scopeLogs entries must be objects');
            for (const rec of list(sl, 'logRecords', 'logRecords')) {
                if (!isObj(rec)) { rejected++; continue; }
                const attrs = pick(rec.attributes, RECORD_KEYS);
                if (!eventNames(rec, attrs).some((n) => API_REQUEST_NAMES.has(n))) continue;
                try {
                    records.push(toUsage(rec, attrs, resource));
                } catch (e) {
                    if (!(e instanceof Invalid)) throw e;
                    rejected++;
                }
            }
        }
    }
    return { records, rejected };
}

/** Validates an ExportMetricsServiceRequest envelope. Metrics are acknowledged but never stored. */
export function validateOtlpMetrics(body: unknown): void {
    const root = envelope(body, 'metrics');
    for (const rm of list(root, 'resourceMetrics', 'resourceMetrics')) {
        if (!isObj(rm)) throw new OtlpEnvelopeError('resourceMetrics entries must be objects');
        for (const sm of list(rm, 'scopeMetrics', 'scopeMetrics')) {
            if (!isObj(sm)) throw new OtlpEnvelopeError('scopeMetrics entries must be objects');
            for (const m of list(sm, 'metrics', 'metrics')) {
                if (!isObj(m)) throw new OtlpEnvelopeError('metrics entries must be objects');
            }
        }
    }
}
