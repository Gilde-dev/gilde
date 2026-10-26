import type { AgentTotals, AgentUsage } from '@/lib/api';

/** Totals with all four token categories filled consistently (totalTokens = uncached + cache read + cache creation + output). */
export const agentTotals = (over: Partial<AgentTotals> = {}): AgentTotals => {
  const t = { uncachedInputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, costUsd: null, runs: 0, costUnknownRequests: 0, costPartial: false, ...over };
  const inputTokens = t.uncachedInputTokens + t.cachedInputTokens + t.cacheCreationTokens;
  return { ...t, reasoningTokens: 0, inputTokens, totalTokens: inputTokens + t.outputTokens };
};

export const noAgentUsage = agentTotals();

export const agentUsage = (over: Partial<AgentUsage> = {}): AgentUsage => ({
  days: 30,
  scope: 'global',
  projectId: null,
  totals: noAgentUsage,
  daily: [{ date: '2026-03-10', ...noAgentUsage }],
  byModel: [],
  byRepo: [],
  byFeature: [],
  unattributed: noAgentUsage,
  ...over,
});
