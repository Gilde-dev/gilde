import type { NotificationKind } from '../config.js';

export interface NotificationPr {
  repo: string;
  number: number;
  url: string;
}

/** Facts of a budget.soft / budget.hard event (apps/api/src/notification `NotificationBudget`). */
export interface NotificationBudget {
  scope: 'global' | 'project';
  period: 'day' | 'week';
  state: 'soft' | 'hard';
  /** Sum of the known estimated costs in USD. */
  spent: number;
  limit: number | null;
  percent: number | null;
  startsAt: string;
  resetsAt: string;
  unpricedRows: number;
  /** `configError`: an invalid global environment variable named in `variable`. */
  reasonKind: 'limit' | 'configError';
  variable: string | null;
}

/** Mirrors `NotificationResponseDto` of the API (apps/api/src/notification). */
export interface GildeNotification {
  id: string;
  occurrenceKey: string;
  kind: NotificationKind;
  occurredAt: string;
  projectId: string | null;
  jobId: string | null;
  featureId: string | null;
  title: string;
  repos: string[];
  reason: string;
  prLinks: NotificationPr[];
  /** Set for the budget kinds only. */
  budget?: NotificationBudget | null;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

/** Thrown by outbound adapters. Permanent errors (bad credentials, unknown channel) are not retried automatically. */
export class NotifyError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'NotifyError';
  }
}

export interface OutboundContext {
  /** Public Gilde URL without trailing slash, used for deep links. */
  publicUrl: string;
}

/** Sends one notification to a platform. Formatting is the adapter's job; the API events are platform-neutral. */
export interface OutboundAdapter {
  name: string;
  send(notification: GildeNotification, context: OutboundContext): Promise<void>;
}
