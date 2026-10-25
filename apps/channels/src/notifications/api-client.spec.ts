import { ApiHttpError, createNotificationApi } from './api-client.js';

describe('notification api client', () => {
  const make = (fetchImpl: unknown) => createNotificationApi({ apiUrl: 'http://api/api', apiKey: 'gk_secret', timeoutMs: 1000, fetchImpl: fetchImpl as typeof fetch });

  it('lists by kinds with the API key', async () => {
    const fetchImpl = vi.fn(async () => new Response('[]'));
    await make(fetchImpl).list(['job.parked', 'revision.waiting'], 7);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api/api/v1/notifications?kinds=job.parked%2Crevision.waiting&limit=7');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gk_secret');
  });

  it('posts delivered and failed', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const api = make(fetchImpl);
    await api.delivered('a');
    await api.failed('a', { reason: 'x', retryable: false });
    expect(fetchImpl.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(['http://api/api/v1/notifications/a/delivered', 'http://api/api/v1/notifications/a/failed']);
  });

  it('throws status-only errors and never echoes the key', async () => {
    await expect(make(async () => new Response('', { status: 500 })).delivered('a')).rejects.toBeInstanceOf(ApiHttpError);
    const error = await make(async () => { throw new Error('failed with gk_secret'); }).delivered('a').catch((e: Error) => e);
    expect((error as Error).message).not.toContain('gk_secret');
  });
});
