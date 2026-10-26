import { SESSION, apiRequest, attrs, dbl, int, logsRequest, otherEvent, sampleLogsRequest, str } from './otel.fixture.js';
import { OtlpEnvelopeError, parseOtlpLogs, validateOtlpMetrics } from './otel-parser.js';

describe('parseOtlpLogs', () => {
  it('keeps only the api_request events with typed values and drops everything else', () => {
    const { records, rejected } = parseOtlpLogs(sampleLogsRequest());
    expect(rejected).toBe(0);
    expect(records).toHaveLength(2);
    const [a, b] = records;
    expect(a).toMatchObject({
      sessionId: SESSION,
      model: 'claude-synthetic-1',
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 3000,
      cacheCreationTokens: 800,
      costUsd: 0.0123,
      durationMs: 2400,
      serviceVersion: '9.9.9-synthetic',
      organizationId: 'org-synthetic',
    });
    expect(a.eventAt.toISOString()).toBe('2023-11-14T22:13:20.123Z');
    // Unknown cost and duration stay null instead of becoming 0.
    expect(b).toMatchObject({ model: 'claude-synthetic-2', costUsd: null, durationMs: null, cacheReadTokens: 0 });
  });

  it('never carries content, prompts, tools, emails or other attributes into the result', () => {
    const json = JSON.stringify(parseOtlpLogs(sampleLogsRequest()));
    for (const s of ['SECRET', 'someone@example', 'SECRET-HOST', 'claude-code', 'prompt', 'tool']) expect(json).not.toContain(s);
    expect(Object.keys(parseOtlpLogs(sampleLogsRequest()).records[0]).sort()).toEqual([
      'cacheCreationTokens', 'cacheReadTokens', 'costUsd', 'durationMs', 'eventAt', 'eventKey', 'inputTokens',
      'model', 'organizationId', 'outputTokens', 'serviceVersion', 'sessionId',
    ]);
  });

  it('accepts snake_case and camelCase aliases, event name in the attributes, eventName field or body', () => {
    const variants = [
      { eventName: 'claude_code.api_request', body: undefined as never, attributes: { 'event.name': null } },
      { attributes: { 'event.name': str('claude_code.api_request') }, body: str('something else') },
      { attributes: { 'event.name': null }, body: str('claude_code.api_request') },
      { attributes: { event_name: str('api_request'), 'event.name': null }, body: str('x') },
    ];
    for (const v of variants) {
      const rec = { ...apiRequest({ attributes: v.attributes, body: v.body }), ...(v.eventName ? { eventName: v.eventName } : {}) };
      if (!v.body) delete (rec as { body?: unknown }).body;
      expect(parseOtlpLogs(logsRequest([rec])).records).toHaveLength(1);
    }
    const camel = apiRequest({
      attributes: {
        'session.id': null, sessionId: str('s-camel'),
        input_tokens: null, inputTokens: int(7), output_tokens: null, outputTokens: int(8),
        cache_read_tokens: null, cacheReadTokens: int(9), cache_creation_tokens: null, cacheCreationTokens: int(10),
        cost_usd: null, costUsd: dbl(1.5), duration_ms: null, durationMs: dbl(12.5),
      },
    });
    expect(parseOtlpLogs(logsRequest([camel])).records[0]).toMatchObject({
      sessionId: 's-camel', inputTokens: 7, outputTokens: 8, cacheReadTokens: 9, cacheCreationTokens: 10, costUsd: 1.5, durationMs: 12.5,
    });
  });

  it('does not take accounting fields from the body', () => {
    const rec = apiRequest({ attributes: { input_tokens: null, model: null }, body: str('input_tokens=5 model=x claude_code.api_request') });
    // Body is not the exact event name, so nothing is identified as an api_request.
    expect(parseOtlpLogs(logsRequest([{ ...rec, attributes: rec.attributes.filter((a) => a.key !== 'event.name') }]))).toEqual({ records: [], rejected: 0 });
  });

  it('reads numeric strings and int64 strings, and keeps nanosecond precision in the key', () => {
    const base = parseOtlpLogs(logsRequest([apiRequest({ attributes: { 'event.sequence': null, input_tokens: str('42') } })])).records[0];
    expect(base.inputTokens).toBe(42);
    const a = parseOtlpLogs(logsRequest([apiRequest({ timeUnixNano: '1700000000123456789', attributes: { 'event.sequence': null } })])).records[0];
    const b = parseOtlpLogs(logsRequest([apiRequest({ timeUnixNano: '1700000000123456790', attributes: { 'event.sequence': null } })])).records[0];
    expect(a.eventAt.getTime()).toBe(b.eventAt.getTime());
    expect(a.eventKey).not.toBe(b.eventKey);
  });

  it('falls back to the event.timestamp attribute when the record has no time', () => {
    const rec = { ...apiRequest({ attributes: { 'event.timestamp': str('2024-01-02T03:04:05.678Z') } }), timeUnixNano: undefined };
    expect(parseOtlpLogs(logsRequest([rec])).records[0].eventAt.toISOString()).toBe('2024-01-02T03:04:05.678Z');
  });

  it('counts malformed api_request records as rejected and keeps the valid ones', () => {
    const bad = [
      apiRequest({ attributes: { 'session.id': null } }),
      apiRequest({ attributes: { model: str('') } }),
      apiRequest({ attributes: { model: str('x'.repeat(300)) } }),
      apiRequest({ attributes: { input_tokens: int(-1) } }),
      apiRequest({ attributes: { input_tokens: int('99999999999999999999') } }),
      apiRequest({ attributes: { input_tokens: dbl(1.5) } }),
      apiRequest({ attributes: { output_tokens: str('abc') } }),
      apiRequest({ attributes: { cost_usd: dbl(-0.1) } }),
      apiRequest({ attributes: { cost_usd: dbl(Number.NaN) } }),
      apiRequest({ attributes: { cost_usd: { boolValue: true } } }),
      apiRequest({ attributes: { duration_ms: str('1e999') } }),
      apiRequest({ attributes: { 'event.sequence': str('x') } }),
      apiRequest({ timeUnixNano: 'abc' }),
      apiRequest({ timeUnixNano: '0' }),
      apiRequest({ timeUnixNano: '999999999999999999999' }),
      'not an object',
    ];
    const { records, rejected } = parseOtlpLogs(logsRequest([...bad, otherEvent(), apiRequest()]));
    expect(rejected).toBe(bad.length);
    expect(records).toHaveLength(1);
  });

  it('gives distinct keys to same-timestamp records and the same key regardless of batching', () => {
    const t = '1700000000000000000';
    const x = apiRequest({ timeUnixNano: t, attributes: { 'event.sequence': null, input_tokens: int(1) } });
    const y = apiRequest({ timeUnixNano: t, attributes: { 'event.sequence': null, input_tokens: int(2) } });
    const whole = parseOtlpLogs(logsRequest([x, y])).records.map((r) => r.eventKey);
    const split = [...parseOtlpLogs(logsRequest([y])).records, ...parseOtlpLogs(logsRequest([x])).records].map((r) => r.eventKey);
    expect(new Set(whole).size).toBe(2);
    expect(new Set(split)).toEqual(new Set(whole));
    // Same fields under a different resource or scope do not change the key either.
    const other = parseOtlpLogs(logsRequest([x], { 'service.version': str('other') })).records[0];
    expect(other.eventKey).toBe(whole[0]);
  });

  it('uses the producer sequence to tell identical records apart', () => {
    const mk = (seq: number) => apiRequest({ attributes: { 'event.sequence': int(seq) } });
    const keys = parseOtlpLogs(logsRequest([mk(1), mk(2), mk(1)])).records.map((r) => r.eventKey);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toBe(keys[2]);
  });

  it('treats identical records without a sequence as one event (documented limitation)', () => {
    const r = apiRequest({ attributes: { 'event.sequence': null } });
    const keys = parseOtlpLogs(logsRequest([r, r])).records.map((x) => x.eventKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it('drops invalid metadata instead of rejecting the record', () => {
    const { records } = parseOtlpLogs(logsRequest([apiRequest()], { 'service.version': str('x'.repeat(500)), 'organization.id': str('a\nb') }));
    expect(records[0]).toMatchObject({ serviceVersion: null, organizationId: null });
  });

  it('rejects malformed envelopes', () => {
    for (const body of [null, 'x', [], 1, { resourceLogs: {} }, { resourceLogs: [1] }, { resourceLogs: [{ scopeLogs: 'x' }] }, { resourceLogs: [{ scopeLogs: [{ logRecords: {} }] }] }, { resourceLogs: [{ scopeLogs: [3] }] }]) {
      expect(() => parseOtlpLogs(body)).toThrow(OtlpEnvelopeError);
    }
  });

  it('accepts empty requests', () => {
    expect(parseOtlpLogs({})).toEqual({ records: [], rejected: 0 });
    expect(parseOtlpLogs({ resourceLogs: [{ scopeLogs: [{}] }] })).toEqual({ records: [], rejected: 0 });
  });
});

describe('validateOtlpMetrics', () => {
  it('accepts well-formed and empty metric requests', () => {
    expect(() => validateOtlpMetrics({})).not.toThrow();
    expect(() => validateOtlpMetrics({ resourceMetrics: [{ resource: { attributes: attrs({}) }, scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { dataPoints: [] } }] }] }] })).not.toThrow();
  });

  it('rejects malformed envelopes', () => {
    for (const body of [null, [], 'x', { resourceMetrics: 'x' }, { resourceMetrics: [{ scopeMetrics: [{ metrics: 'x' }] }] }, { resourceMetrics: [null] }]) {
      expect(() => validateOtlpMetrics(body)).toThrow(OtlpEnvelopeError);
    }
  });
});
