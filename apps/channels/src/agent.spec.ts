import { afterEach, vi } from 'vitest';

const getRemoteAgents = vi.hoisted(() => vi.fn());
vi.mock('@ag-ui/mastra', () => ({ getRemoteAgents }));

import { COPILOT_AGENT_ID, createCopilotAgent, fetchBotUserId } from './agent.js';

const KEY = 'gk_12345678_secret-value';
const config = { apiUrl: 'http://api.test/api', apiKey: KEY };

function mockFetch(impl: () => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  getRemoteAgents.mockReset();
});

describe('fetchBotUserId', () => {
  it('returns the id from /v1/auth/me, authenticated with the key', async () => {
    const fn = mockFetch(async () => Response.json({ id: 'user-1', email: 'bot@example.com' }));
    await expect(fetchBotUserId(config)).resolves.toBe('user-1');
    expect(fn).toHaveBeenCalledWith('http://api.test/api/v1/auth/me', { headers: { Authorization: `Bearer ${KEY}` } });
  });

  it('fails clearly on 401 without the key', async () => {
    mockFetch(async () => new Response('{}', { status: 401 }));
    const error = await fetchBotUserId(config).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/API key is invalid/);
    expect((error as Error).message).not.toContain(KEY);
  });

  it('fails clearly on a network error without the key', async () => {
    mockFetch(async () => {
      throw new TypeError(`fetch failed (Authorization: Bearer ${KEY})`);
    });
    const error = await fetchBotUserId(config).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/Cannot reach the Gilde API/);
    expect((error as Error).message).not.toContain(KEY);
  });

  it('fails on other statuses and on a response without id', async () => {
    mockFetch(async () => new Response('', { status: 500 }));
    await expect(fetchBotUserId(config)).rejects.toThrow(/answered 500/);
    mockFetch(async () => Response.json({}));
    await expect(fetchBotUserId(config)).rejects.toThrow(/no user id/);
  });
});

describe('createCopilotAgent', () => {
  it('passes the id from /auth/me as resourceId', async () => {
    mockFetch(async () => Response.json({ id: 'user-1' }));
    const agent = {};
    getRemoteAgents.mockResolvedValue({ [COPILOT_AGENT_ID]: agent });
    await expect(createCopilotAgent(config)).resolves.toBe(agent);
    expect(getRemoteAgents).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'user-1' }));
  });

  it('does not build the agent when /auth/me fails', async () => {
    mockFetch(async () => new Response('{}', { status: 401 }));
    await expect(createCopilotAgent(config)).rejects.toThrow(/invalid/);
    expect(getRemoteAgents).not.toHaveBeenCalled();
  });
});
