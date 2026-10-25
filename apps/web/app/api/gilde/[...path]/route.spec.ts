import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DELETE, GET, PATCH, POST, PUT } from './route';

afterEach(() => vi.unstubAllGlobals());

const call = (handler: typeof GET, method: string, path: string, init: { body?: string; cookie?: string } = {}) =>
  handler(
    new NextRequest(`http://localhost:3000/api/gilde/${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(init.cookie ? { cookie: `gilde_session=${init.cookie}` } : {}) },
      ...(init.body ? { body: init.body } : {}),
    }),
    { params: Promise.resolve({ path: path.split('?')[0].split('/') }) },
  );

describe('api proxy', () => {
  it('forwards method, path, query, body and the bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":"j"}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(POST, 'POST', 'v1/repos/r1/jobs?x=1', { body: '{"title":"t"}', cookie: 'tok' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'j' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:4100/api/v1/repos/r1/jobs?x=1');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"title":"t"}');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it.each([
    ['GET', GET],
    ['PATCH', PATCH],
    ['PUT', PUT],
    ['DELETE', DELETE],
  ])('supports %s', async (method, handler) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await call(handler, method, 'v1/jobs/1', { cookie: 'tok' });
    expect(fetchMock.mock.calls[0][1].method).toBe(method);
  });

  it('clears the cookie on a 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"message":"Unauthorized"}', { status: 401 })));
    const res = await call(GET, 'GET', 'v1/jobs', { cookie: 'old' });
    expect(res.status).toBe(401);
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toContain('gilde_session=;');
    expect(set).toMatch(/Max-Age=0/i);
  });

  it('does not clear the cookie on other errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    const res = await call(GET, 'GET', 'v1/jobs/x', { cookie: 'tok' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('streams the response body through without buffering it', async () => {
    let push!: (chunk: string) => void;
    let close!: () => void;
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(encoder.encode(chunk));
        close = () => controller.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(upstreamBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);

    // The handler resolves while the upstream is still open: it did not wait for the full text.
    const res = await call(POST, 'POST', 'v1/mastra/copilotkit', { body: '{}', cookie: 'tok' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-transform');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    push('data: one\n\n');
    expect(decoder.decode((await reader.read()).value)).toBe('data: one\n\n');
    push('data: two\n\n');
    expect(decoder.decode((await reader.read()).value)).toBe('data: two\n\n');
    close();
    expect((await reader.read()).done).toBe(true);
  });

  it('forwards the Accept header of the client', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await handlerWithAccept('text/event-stream');
    expect(fetchMock.mock.calls[0][1].headers.Accept).toBe('text/event-stream');
  });
});

const handlerWithAccept = (accept: string) =>
  POST(
    new NextRequest('http://localhost:3000/api/gilde/v1/mastra/copilotkit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept },
      body: '{}',
    }),
    { params: Promise.resolve({ path: ['v1', 'mastra', 'copilotkit'] }) },
  );
