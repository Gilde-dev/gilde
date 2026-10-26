import { hasValidIngestToken, isJsonContentType, isOtelIngestPath, otelIngestConfig, otelRateLimit } from './otel.config.js';

const GOOD = 'a'.repeat(40);

describe('otelIngestConfig', () => {
  it('is disabled without a token', () => {
    expect(otelIngestConfig({})).toEqual({ state: 'disabled' });
    expect(otelIngestConfig({ OTEL_INGEST_TOKEN: '   ' })).toEqual({ state: 'disabled' });
  });

  it('fails closed for short tokens and gk_ tokens without echoing the value', () => {
    const short = otelIngestConfig({ OTEL_INGEST_TOKEN: 'short-secret' });
    expect(short.state).toBe('invalid');
    expect(JSON.stringify(short)).not.toContain('short-secret');
    const gk = otelIngestConfig({ OTEL_INGEST_TOKEN: `gk_${GOOD}` });
    expect(gk.state).toBe('invalid');
    expect(JSON.stringify(gk)).not.toContain(GOOD);
  });

  it('enables a token of 32+ characters', () => {
    expect(otelIngestConfig({ OTEL_INGEST_TOKEN: ` ${GOOD} ` })).toEqual({ state: 'enabled', token: GOOD });
    expect(otelIngestConfig({ OTEL_INGEST_TOKEN: 'b'.repeat(32) }).state).toBe('enabled');
    expect(otelIngestConfig({ OTEL_INGEST_TOKEN: 'b'.repeat(31) }).state).toBe('invalid');
  });
});

describe('hasValidIngestToken', () => {
  const enabled = otelIngestConfig({ OTEL_INGEST_TOKEN: GOOD });
  it('matches only the exact bearer token', () => {
    expect(hasValidIngestToken(`Bearer ${GOOD}`, enabled)).toBe(true);
    expect(hasValidIngestToken(`bearer ${GOOD}`, enabled)).toBe(true);
    for (const h of [undefined, '', 'Bearer ', `Bearer ${GOOD}x`, GOOD, `Bearer gk_x_y`, 'Bearer a.b.c']) expect(hasValidIngestToken(h, enabled)).toBe(false);
    expect(hasValidIngestToken(`Bearer ${GOOD}`, { state: 'disabled' })).toBe(false);
  });
});

describe('helpers', () => {
  it('recognises JSON content types', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('Application/JSON; charset=utf-8')).toBe(true);
    for (const t of [undefined, 'application/x-protobuf', 'text/plain', 'application/jsonx']) expect(isJsonContentType(t)).toBe(false);
  });

  it('matches exactly the two ingest paths', () => {
    expect(isOtelIngestPath('/api/v1/otel/v1/logs')).toBe(true);
    expect(isOtelIngestPath('/API/v1/otel/v1/metrics/')).toBe(true);
    for (const p of ['/api/v1/otel/v1/traces', '/api/v1/otel', '/api/v1/usage', '/v1/otel/v1/logs']) expect(isOtelIngestPath(p)).toBe(false);
  });

  it('reads the rate limit with a default', () => {
    expect(otelRateLimit({})).toBe(120);
    expect(otelRateLimit({ OTEL_INGEST_RATE_LIMIT: '5' })).toBe(5);
    expect(otelRateLimit({ OTEL_INGEST_RATE_LIMIT: '-1' })).toBe(120);
  });
});
