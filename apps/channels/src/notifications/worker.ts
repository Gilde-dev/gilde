import { ApiHttpError, type NotificationApi } from './api-client.js';
import type { NotificationsConfig } from '../config.js';
import { errorMessage } from './sanitize.js';
import { NotifyError, type GildeNotification, type OutboundAdapter } from './types.js';

const MAX_RETRY_SECONDS = 24 * 60 * 60;
const ACK_ATTEMPTS = 3;

export type NotificationWorkerConfig = Pick<NotificationsConfig, 'kinds' | 'publicUrl' | 'pollIntervalMs' | 'batchSize' | 'retryBaseMs' | 'retryMaxMs'>;

export interface WorkerDeps {
  api: NotificationApi;
  adapter: OutboundAdapter;
  config: NotificationWorkerConfig;
  secrets?: string[];
  log?: (message: string) => void;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Capped exponential backoff with jitter (50-100% of the capped delay). */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const capped = Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(attempt, 30)));
  return Math.round(capped / 2 + (random() * capped) / 2);
}

/**
 * One serial polling loop: list due notifications, post each, mark it delivered. A pass never overlaps the next:
 * the following pass is scheduled only after the current one finished. At-least-once: a crash between the post
 * and the acknowledgement resends; while the process lives an unacknowledged success is retried instead of reposted.
 */
export class NotificationWorker {
  private readonly log: (message: string) => void;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Ids that were posted successfully but whose acknowledgement failed; acknowledged again before anything is reposted. */
  private readonly unacknowledged = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private started = false;
  private apiFailures = 0;
  private current: Promise<void> | undefined;

  constructor(private readonly deps: WorkerDeps) {
    this.log = deps.log ?? ((message) => console.log(message));
    this.random = deps.random ?? Math.random;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.schedule(0);
  }

  /** Stops scheduling and waits for the pass in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.current;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.current = this.loop();
    }, delayMs);
    this.timer.unref?.();
  }

  private async loop(): Promise<void> {
    let nextDelay = this.deps.config.pollIntervalMs;
    try {
      const reachable = await this.runOnce();
      this.apiFailures = reachable ? 0 : this.apiFailures + 1;
      if (!reachable) nextDelay = Math.max(nextDelay, backoffMs(this.apiFailures, this.deps.config.retryBaseMs, this.deps.config.retryMaxMs, this.random));
    } catch (error) {
      this.apiFailures += 1;
      this.log(`notifications: pass failed: ${errorMessage(error, this.deps.secrets)}`);
      nextDelay = Math.max(nextDelay, backoffMs(this.apiFailures, this.deps.config.retryBaseMs, this.deps.config.retryMaxMs, this.random));
    }
    this.schedule(nextDelay);
  }

  /** Runs one pass. Returns false when the Gilde API could not be reached or answered with an error. */
  async runOnce(): Promise<boolean> {
    if (this.running) return true;
    this.running = true;
    try {
      const { api, config } = this.deps;
      if (config.kinds.length === 0) return true;
      let list: GildeNotification[];
      try {
        list = await api.list(config.kinds, config.batchSize);
      } catch (error) {
        this.log(`notifications: listing failed: ${errorMessage(error, this.deps.secrets)}`);
        return false;
      }
      let apiOk = true;
      for (const notification of list) {
        if (this.stopped) break;
        apiOk = (await this.handle(notification)) && apiOk;
      }
      return apiOk;
    } finally {
      this.running = false;
    }
  }

  /** Returns false when the Gilde API failed while recording the outcome. */
  private async handle(notification: GildeNotification): Promise<boolean> {
    const { api, adapter, config, secrets } = this.deps;
    if (!this.unacknowledged.has(notification.id)) {
      try {
        await adapter.send(notification, { publicUrl: config.publicUrl });
      } catch (error) {
        return this.reportFailure(notification, error);
      }
      this.unacknowledged.add(notification.id);
    }
    for (let attempt = 1; attempt <= ACK_ATTEMPTS; attempt += 1) {
      try {
        await api.delivered(notification.id);
        this.unacknowledged.delete(notification.id);
        this.log(`notifications: delivered ${notification.id} (${notification.kind}) via ${adapter.name}`);
        return true;
      } catch (error) {
        if (error instanceof ApiHttpError && error.status >= 400 && error.status < 500) {
          // The API will never accept it (gone or invalid); do not keep it around.
          this.unacknowledged.delete(notification.id);
          this.log(`notifications: acknowledgement of ${notification.id} rejected (HTTP ${error.status})`);
          return true;
        }
        if (attempt === ACK_ATTEMPTS) {
          this.log(`notifications: acknowledgement of ${notification.id} failed, will retry: ${errorMessage(error, secrets)}`);
          return false;
        }
        await this.sleep(backoffMs(attempt - 1, 200, 2_000, this.random));
      }
    }
    return false;
  }

  private async reportFailure(notification: GildeNotification, error: unknown): Promise<boolean> {
    const { api, config, secrets } = this.deps;
    const permanent = error instanceof NotifyError && error.permanent;
    const reason = errorMessage(error, secrets);
    let retryAfterMs = backoffMs(notification.attempts, config.retryBaseMs, config.retryMaxMs, this.random);
    if (error instanceof NotifyError && error.retryAfterMs) retryAfterMs = Math.max(retryAfterMs, error.retryAfterMs);
    const retryAfterSeconds = Math.min(MAX_RETRY_SECONDS, Math.max(1, Math.ceil(retryAfterMs / 1000)));
    this.log(`notifications: send of ${notification.id} (${notification.kind}) failed${permanent ? ' permanently' : `, retry in ${retryAfterSeconds}s`}: ${reason}`);
    try {
      await api.failed(notification.id, permanent ? { reason, retryable: false } : { reason, retryable: true, retryAfterSeconds });
      return true;
    } catch (reportError) {
      this.log(`notifications: could not record failure of ${notification.id}: ${errorMessage(reportError, secrets)}`);
      return false;
    }
  }
}
