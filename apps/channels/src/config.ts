import { z } from 'zod';

const optional = z.string().trim().min(1).optional();

const envSchema = z
  .object({
    GILDE_API_URL: z.string().trim().url().default('http://localhost:4100/api'),
    GILDE_API_KEY: z.string({ error: 'GILDE_API_KEY is required' }).trim().min(1, 'GILDE_API_KEY is required'),
    SLACK_BOT_TOKEN: optional,
    SLACK_APP_TOKEN: optional,
  })
  .superRefine((env, ctx) => {
    if (!env.SLACK_BOT_TOKEN !== !env.SLACK_APP_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: [env.SLACK_BOT_TOKEN ? 'SLACK_APP_TOKEN' : 'SLACK_BOT_TOKEN'],
        message: 'Slack needs both SLACK_BOT_TOKEN and SLACK_APP_TOKEN; set both or neither',
      });
    }
  });

export interface ChannelsConfig {
  apiUrl: string;
  apiKey: string;
  slack?: { botToken: string; appToken: string };
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
  const { GILDE_API_URL, GILDE_API_KEY, SLACK_BOT_TOKEN, SLACK_APP_TOKEN } = parsed.data;
  return {
    apiUrl: GILDE_API_URL.replace(/\/+$/, ''),
    apiKey: GILDE_API_KEY,
    slack: SLACK_BOT_TOKEN && SLACK_APP_TOKEN ? { botToken: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN } : undefined,
  };
}
