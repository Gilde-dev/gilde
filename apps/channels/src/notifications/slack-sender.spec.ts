import { notification } from './fixtures.js';
import { createSlackSender } from './slack-sender.js';
import { NotifyError } from './types.js';

const ctx = { publicUrl: 'https://g' };
const options = { botToken: 'xoxb-secret-token', channelId: 'C1', timeoutMs: 1000 };

function sender(fetchImpl: typeof fetch) {
  return createSlackSender({ ...options, fetchImpl });
}
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);

describe('slack sender', () => {
  it('posts to the configured channel with the token in the header only', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }));
    await sender(fetchImpl as unknown as typeof fetch).send(notification(), ctx);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-secret-token');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ channel: 'C1', link_names: false });
    expect(init.body).not.toContain('xoxb');
  });

  it('reads Retry-After on 429 as a transient failure', async () => {
    const fetchImpl = async () => new Response('', { status: 429, headers: { 'Retry-After': '7' } });
    await expect(sender(fetchImpl as unknown as typeof fetch).send(notification(), ctx)).rejects.toMatchObject({ permanent: false, retryAfterMs: 7000 });
  });

  it.each(['invalid_auth', 'channel_not_found', 'not_in_channel', 'is_archived'])('treats %s as permanent', async (error) => {
    const fetchImpl = async () => json({ ok: false, error });
    await expect(sender(fetchImpl as unknown as typeof fetch).send(notification(), ctx)).rejects.toMatchObject({ permanent: true });
  });

  it('treats other Slack errors and 5xx as transient', async () => {
    await expect(sender((async () => json({ ok: false, error: 'internal_error' })) as unknown as typeof fetch).send(notification(), ctx)).rejects.toMatchObject({ permanent: false });
    await expect(sender((async () => new Response('', { status: 503 })) as unknown as typeof fetch).send(notification(), ctx)).rejects.toMatchObject({ permanent: false });
  });

  it('redacts the token from network errors', async () => {
    const fetchImpl = async () => {
      throw new Error('connect failed for Bearer xoxb-secret-token');
    };
    const error = await sender(fetchImpl as unknown as typeof fetch).send(notification(), ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotifyError);
    expect((error as Error).message).not.toContain('secret-token');
  });
});
