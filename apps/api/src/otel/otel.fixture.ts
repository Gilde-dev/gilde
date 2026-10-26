/**
 * Constructed OTLP/HTTP JSON fixtures. No real Claude Code export was available when these were written, so the
 * attribute names follow Claude Code's monitoring documentation (event.name, session.id, input_tokens, ...) and no
 * real names, ids or payloads were observed. All values are synthetic.
 */

type AnyValue = Record<string, unknown>;
export const str = (stringValue: string): AnyValue => ({ stringValue });
export const int = (n: number | string): AnyValue => ({ intValue: String(n) });
export const dbl = (doubleValue: number): AnyValue => ({ doubleValue });

export const attrs = (o: Record<string, AnyValue>) => Object.entries(o).map(([key, value]) => ({ key, value }));

export const SESSION = 'session-synthetic-0001';

export function apiRequest(over: { timeUnixNano?: string; attributes?: Record<string, AnyValue | null>; body?: AnyValue } = {}) {
    const attributes: Record<string, AnyValue | null> = {
        'event.name': str('api_request'),
        'session.id': str(SESSION),
        'event.sequence': int(1),
        model: str('claude-synthetic-1'),
        input_tokens: int(120),
        output_tokens: int(45),
        cache_read_tokens: int(3000),
        cache_creation_tokens: int(800),
        cost_usd: dbl(0.0123),
        duration_ms: int(2400),
        // Sensitive content that must never be stored or logged.
        'user.email': str('someone@example.invalid'),
        prompt: str('SECRET PROMPT TEXT'),
        'user_prompt': str('SECRET USER PROMPT'),
        'tool_input': str('SECRET TOOL INPUT'),
        'tool_output.content': str('SECRET TOOL OUTPUT'),
        ...over.attributes,
    };
    return {
        timeUnixNano: over.timeUnixNano ?? '1700000000123456789',
        body: over.body ?? str('claude_code.api_request'),
        attributes: attrs(Object.fromEntries(Object.entries(attributes).filter((e): e is [string, AnyValue] => e[1] !== null))),
    };
}

export function otherEvent() {
    return {
        timeUnixNano: '1700000001000000000',
        body: str('claude_code.user_prompt'),
        attributes: attrs({
            'event.name': str('user_prompt'),
            'session.id': str(SESSION),
            prompt: str('SECRET PROMPT TEXT'),
            input_tokens: int(999999),
        }),
    };
}

export function logsRequest(logRecords: unknown[], resourceAttributes: Record<string, AnyValue> = {}) {
    return {
        resourceLogs: [{
            resource: {
                attributes: attrs({
                    'service.name': str('claude-code'),
                    'service.version': str('9.9.9-synthetic'),
                    'organization.id': str('org-synthetic'),
                    'host.name': str('SECRET-HOST'),
                    ...resourceAttributes,
                }),
            },
            scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events', version: '9.9.9' }, logRecords }],
        }],
    };
}

/** Two api_request events, one unrelated event, all with sensitive content. */
export function sampleLogsRequest() {
    return logsRequest([
        apiRequest(),
        otherEvent(),
        apiRequest({
            timeUnixNano: '1700000002000000000',
            attributes: { 'event.sequence': int(2), model: str('claude-synthetic-2'), input_tokens: int(10), output_tokens: int(5), cache_read_tokens: int(0), cache_creation_tokens: int(0), cost_usd: null, duration_ms: null },
        }),
    ]);
}

export const SENSITIVE = ['SECRET', 'someone@example.invalid'];
