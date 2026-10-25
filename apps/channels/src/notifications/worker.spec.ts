import { ApiHttpError, type NotificationApi } from './api-client.js';
import { notification } from './fixtures.js';
import { NotifyError, type GildeNotification, type OutboundAdapter } from './types.js';
import { backoffMs, NotificationWorker } from './worker.js';

const config = { kinds: ['job.awaiting_review' as const], publicUrl: 'https://g', pollIntervalMs: 1000, batchSize: 5, retryBaseMs: 10_000, retryMaxMs: 100_000 };

/** A tiny in-memory stand-in for the API: delivered rows are never listed again, like the real endpoint. */
function fakeApi(rows: GildeNotification[]) {
  const state = { rows: [...rows], delivered: [] as string[], failures: [] as { id: string; report: unknown }[], listCalls: 0 };
  const api: NotificationApi & { ackError?: Error; listError?: Error } = {
    async list() {
      state.listCalls += 1;
      if (api.listError) throw api.listError;
      return state.rows.filter((r) => !state.delivered.includes(r.id));
    },
    async delivered(id) {
      if (api.ackError) throw api.ackError;
      state.delivered.push(id);
    },
    async failed(id, report) {
      state.failures.push({ id, report });
    },
  };
  return { api, state };
}

function worker(api: NotificationApi, adapter: OutboundAdapter, extra: Record<string, unknown> = {}) {
  return new NotificationWorker({ api, adapter, config, random: () => 1, sleep: async () => {}, log: () => {}, secrets: ['xoxb-secret'], ...extra });
}

describe('backoffMs', () => {
  it('grows exponentially, is capped, and jitters between half and full', () => {
    expect(backoffMs(0, 1000, 60_000, () => 1)).toBe(1000);
    expect(backoffMs(2, 1000, 60_000, () => 1)).toBe(4000);
    expect(backoffMs(2, 1000, 60_000, () => 0)).toBe(2000);
    expect(backoffMs(20, 1000, 60_000, () => 1)).toBe(60_000);
  });
});

describe('NotificationWorker', () => {
  it('sends then acknowledges, and does not replay delivered events', async () => {
    const { api, state } = fakeApi([notification()]);
    const send = vi.fn(async () => {});
    const w = worker(api, { name: 'fake', send });
    await w.runOnce();
    await w.runOnce();
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.delivered).toEqual([notification().id]);
  });

  it('records a transient failure with capped backoff and Retry-After', async () => {
    const { api, state } = fakeApi([notification({ attempts: 2 })]);
    const send = vi.fn(async () => {
      throw new NotifyError('Slack rate limited the request', false, 300_000);
    });
    await worker(api, { name: 'fake', send }).runOnce();
    expect(state.failures[0]?.report).toEqual({ reason: 'Slack rate limited the request', retryable: true, retryAfterSeconds: 300 });
    expect(state.delivered).toEqual([]);
  });

  it('uses exponential backoff by attempt', async () => {
    const { api, state } = fakeApi([notification({ attempts: 3 })]);
    await worker(api, { name: 'fake', send: async () => { throw new NotifyError('boom', false); } }).runOnce();
    expect(state.failures[0]?.report).toMatchObject({ retryable: true, retryAfterSeconds: 80 });
  });

  it('marks permanent failures as not retryable', async () => {
    const { api, state } = fakeApi([notification()]);
    await worker(api, { name: 'fake', send: async () => { throw new NotifyError('Slack error: channel_not_found', true); } }).runOnce();
    expect(state.failures[0]?.report).toEqual({ reason: 'Slack error: channel_not_found', retryable: false });
  });

  it('treats unknown errors as ordinary retryable failures and redacts secrets', async () => {
    const { api, state } = fakeApi([notification()]);
    await worker(api, { name: 'fake', send: async () => { throw new Error('socket hang up xoxb-secret'); } }).runOnce();
    const report = state.failures[0]?.report as { reason: string; retryable: boolean };
    expect(report.retryable).toBe(true);
    expect(report.reason).not.toContain('xoxb-secret');
  });

  it('retries a known-success acknowledgement without reposting', async () => {
    const { api, state } = fakeApi([notification()]);
    api.ackError = new Error('api down');
    const send = vi.fn(async () => {});
    const w = worker(api, { name: 'fake', send });
    expect(await w.runOnce()).toBe(false);
    api.ackError = undefined;
    expect(await w.runOnce()).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.delivered).toHaveLength(1);
  });

  it('may resend after a restart before the acknowledgement (documented duplicate)', async () => {
    const { api } = fakeApi([notification()]);
    api.ackError = new Error('crash');
    const send = vi.fn(async () => {});
    await worker(api, { name: 'fake', send }).runOnce();
    api.ackError = undefined;
    await worker(api, { name: 'fake', send }).runOnce(); // new process, empty memory
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not replay after a restart that follows the acknowledgement', async () => {
    const { api } = fakeApi([notification()]);
    const send = vi.fn(async () => {});
    await worker(api, { name: 'fake', send }).runOnce();
    await worker(api, { name: 'fake', send }).runOnce();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('drops an acknowledgement the API rejects with 4xx', async () => {
    const { api } = fakeApi([notification()]);
    api.ackError = new ApiHttpError(404);
    const send = vi.fn(async () => {});
    const w = worker(api, { name: 'fake', send });
    expect(await w.runOnce()).toBe(true);
  });

  it('reports API errors so the loop backs off', async () => {
    const { api } = fakeApi([]);
    api.listError = new Error('Bearer gk_secret down');
    expect(await worker(api, { name: 'fake', send: vi.fn() }).runOnce()).toBe(false);
  });

  it('does not overlap passes', async () => {
    const { api } = fakeApi([notification()]);
    let release!: () => void;
    const send = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const w = worker(api, { name: 'fake', send });
    const first = w.runOnce();
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    await w.runOnce();
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('queries only configured kinds and skips polling when none are enabled', async () => {
    const { api, state } = fakeApi([]);
    const list = vi.spyOn(api, 'list');
    await worker(api, { name: 'fake', send: vi.fn() }).runOnce();
    expect(list).toHaveBeenCalledWith(['job.awaiting_review'], 5);
    await new NotificationWorker({ api, adapter: { name: 'f', send: vi.fn() }, config: { ...config, kinds: [] }, log: () => {} }).runOnce();
    expect(state.listCalls).toBe(1);
  });

  describe('loop', () => {
    afterEach(() => vi.useRealTimers());

    it('polls repeatedly, survives failures and stops on request', async () => {
      vi.useFakeTimers();
      const { api, state } = fakeApi([]);
      api.listError = new Error('down');
      const w = worker(api, { name: 'fake', send: vi.fn() });
      w.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(state.listCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(200_000);
      expect(state.listCalls).toBeGreaterThan(1);
      await w.stop();
      const calls = state.listCalls;
      await vi.advanceTimersByTimeAsync(500_000);
      expect(state.listCalls).toBe(calls);
    });
  });
});
