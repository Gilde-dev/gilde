import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('returns parsed JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: 'p' }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.listProjects()).resolves.toEqual([{ id: 'p' }]);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:4100/api/v1/projects');
  });

  it('throws a readable error on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Job not found' }), { status: 404 })));
    await expect(api.getJob('x')).rejects.toThrow('GET /v1/jobs/x failed: 404 Job not found');
  });
});
