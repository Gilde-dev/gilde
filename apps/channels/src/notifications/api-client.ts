import { errorMessage } from './sanitize.js';
import type { NotificationKind } from '../config.js';
import type { GildeNotification } from './types.js';

export class ApiHttpError extends Error {
  constructor(readonly status: number) {
    super(`Gilde API answered HTTP ${status}`);
    this.name = 'ApiHttpError';
  }
}

export interface FailureReport {
  reason: string;
  retryable: boolean;
  retryAfterSeconds?: number;
}

export interface NotificationApi {
  list(kinds: NotificationKind[], limit: number): Promise<GildeNotification[]>;
  delivered(id: string): Promise<void>;
  failed(id: string, report: FailureReport): Promise<void>;
}

export function createNotificationApi(options: { apiUrl: string; apiKey: string; timeoutMs: number; fetchImpl?: typeof fetch }): NotificationApi {
  const doFetch = options.fetchImpl ?? fetch;
  async function call(path: string, init: { method: string; body?: unknown } = { method: 'GET' }): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${options.apiUrl}/v1/notifications${path}`, {
        method: init.method,
        headers: { Authorization: `Bearer ${options.apiKey}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      throw new Error(`Gilde API request failed: ${errorMessage(error, [options.apiKey])}`);
    }
    if (!response.ok) throw new ApiHttpError(response.status);
    return response.json();
  }
  return {
    async list(kinds, limit) {
      const query = new URLSearchParams({ kinds: kinds.join(','), limit: String(limit) });
      const body = await call(`?${query.toString()}`);
      if (!Array.isArray(body)) throw new Error('Gilde API returned an unexpected notifications response');
      return body as GildeNotification[];
    },
    async delivered(id) {
      await call(`/${encodeURIComponent(id)}/delivered`, { method: 'POST' });
    },
    async failed(id, report) {
      await call(`/${encodeURIComponent(id)}/failed`, { method: 'POST', body: report });
    },
  };
}
