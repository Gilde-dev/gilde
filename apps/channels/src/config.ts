import { z } from 'zod';

const optional = z.string().trim().min(1).optional();

export const NOTIFICATION_KINDS = [
  'job.awaiting_review',
  'job.parked',
  'job.approval_needed',
  'revision.waiting',
  'feature.ready_to_close',
  'budget.soft',
  'budget.hard',
  'executor.exhausted',
  'spec.planned',
  'spec.plan_failed',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

const flag = z
  .enum(['true', 'false', '1', '0'], { error: 'must be true or false' })
  .transform((value) => value === 'true' || value === '1')
  .optional();
const bounded = (min: number, max: number, fallback: number) =>
  z.coerce.number({ error: 'must be a number' }).int().min(min).max(max).default(fallback);

const envSchema = z
  .object({
    GILDE_API_URL: z.string().trim().url().default('http://localhost:4100/api'),
    GILDE_API_KEY: z.string({ error: 'GILDE_API_KEY is required' }).trim().min(1, 'GILDE_API_KEY is required'),
    SLACK_BOT_TOKEN: optional,
    SLACK_APP_TOKEN: optional,
    NOTIFICATIONS_ENABLED: flag,
    NOTIFICATION_KINDS: optional,
    NOTIFICATION_SLACK_CHANNEL_ID: z.string().trim().regex(/^[CGD][A-Z0-9]{2,}$/, 'must be a Slack channel ID like C0123456789').optional(),
    GILDE_PUBLIC_URL: z.string().trim().url().optional(),
    NOTIFICATION_POLL_INTERVAL_MS: bounded(1_000, 3_600_000, 15_000),
    NOTIFICATION_BATCH_SIZE: bounded(1, 100, 10),
    NOTIFICATION_REQUEST_TIMEOUT_MS: bounded(1_000, 120_000, 10_000),
    NOTIFICATION_RETRY_BASE_MS: bounded(1_000, 3_600_000, 30_000),
    NOTIFICATION_RETRY_MAX_MS: bounded(1_000, 86_400_000, 3_600_000),
  })
  .superRefine((env, ctx) => {
    if (!env.SLACK_BOT_TOKEN !== !env.SLACK_APP_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: [env.SLACK_BOT_TOKEN ? 'SLACK_APP_TOKEN' : 'SLACK_BOT_TOKEN'],
        message: 'Slack needs both SLACK_BOT_TOKEN and SLACK_APP_TOKEN; set both or neither',
      });
    }
    if (env.NOTIFICATIONS_ENABLED) {
      for (const [name, value] of [
        ['SLACK_BOT_TOKEN', env.SLACK_BOT_TOKEN],
        ['NOTIFICATION_SLACK_CHANNEL_ID', env.NOTIFICATION_SLACK_CHANNEL_ID],
        ['GILDE_PUBLIC_URL', env.GILDE_PUBLIC_URL],
      ] as const) {
        if (!value) ctx.addIssue({ code: 'custom', path: [name], message: `${name} is required when NOTIFICATIONS_ENABLED is true` });
      }
      for (const kind of parseKinds(env.NOTIFICATION_KINDS).invalid) {
        ctx.addIssue({ code: 'custom', path: ['NOTIFICATION_KINDS'], message: `unknown kind "${kind}"` });
      }
    }
  });

function parseKinds(raw: string | undefined): { kinds: NotificationKind[]; invalid: string[] } {
  if (!raw) return { kinds: [...NOTIFICATION_KINDS], invalid: [] };
  const names = [...new Set(raw.split(',').map((k) => k.trim()).filter(Boolean))];
  const known = (name: string): name is NotificationKind => (NOTIFICATION_KINDS as readonly string[]).includes(name);
  return { kinds: names.filter(known), invalid: names.filter((name) => !known(name)) };
}

export interface NotificationsConfig {
  /** Kinds that are polled; others stay unsent until enabled. */
  kinds: NotificationKind[];
  slack: { botToken: string; channelId: string };
  publicUrl: string;
  pollIntervalMs: number;
  batchSize: number;
  requestTimeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

export interface ChannelsConfig {
  apiUrl: string;
  apiKey: string;
  slack?: { botToken: string; appToken: string };
  /** Present when NOTIFICATIONS_ENABLED is true. Needs only the bot token, not Socket Mode. */
  notifications?: NotificationsConfig;
}

/** Parses the environment. The error message names the variables only, never their values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): ChannelsConfig {
  // Empty values count as unset, so `.env.example` can list every variable.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n- ${problems.join('\n- ')}`);
  }
  const { GILDE_API_URL, GILDE_API_KEY, SLACK_BOT_TOKEN, SLACK_APP_TOKEN, ...rest } = parsed.data;
  const notifications: NotificationsConfig | undefined =
    rest.NOTIFICATIONS_ENABLED && SLACK_BOT_TOKEN && rest.NOTIFICATION_SLACK_CHANNEL_ID && rest.GILDE_PUBLIC_URL
      ? {
          kinds: parseKinds(rest.NOTIFICATION_KINDS).kinds,
          slack: { botToken: SLACK_BOT_TOKEN, channelId: rest.NOTIFICATION_SLACK_CHANNEL_ID },
          publicUrl: rest.GILDE_PUBLIC_URL.replace(/\/+$/, ''),
          pollIntervalMs: rest.NOTIFICATION_POLL_INTERVAL_MS,
          batchSize: rest.NOTIFICATION_BATCH_SIZE,
          requestTimeoutMs: rest.NOTIFICATION_REQUEST_TIMEOUT_MS,
          retryBaseMs: rest.NOTIFICATION_RETRY_BASE_MS,
          retryMaxMs: Math.max(rest.NOTIFICATION_RETRY_MAX_MS, rest.NOTIFICATION_RETRY_BASE_MS),
        }
      : undefined;
  return {
    apiUrl: GILDE_API_URL.replace(/\/+$/, ''),
    apiKey: GILDE_API_KEY,
    slack: SLACK_BOT_TOKEN && SLACK_APP_TOKEN ? { botToken: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN } : undefined,
    notifications,
  };
}
