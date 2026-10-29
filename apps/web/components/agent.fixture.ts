import type { Agent, AgentPrompt, AgentRunDetail, AgentRunSummary, AgentTools, SlackBot } from '@/lib/api';

export const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'verfijner',
  label: 'Verfijner',
  status: 'on',
  reason: null,
  enabled: true,
  model: 'openai/gpt-5-mini',
  effectiveModel: 'openai/gpt-5-mini',
  hasModel: true,
  hasBotUser: true,
  botUserId: 'b1',
  botUser: { id: 'b1', name: 'Refiner', email: 'refiner@bots.test' },
  settings: { dailyLimit: 10 },
  fields: [{ key: 'dailyLimit', label: 'Runs per project per day', kind: 'int', min: 1, max: 9007199254740991, default: 20 }],
  updatedAt: '2026-10-29T10:00:00.000Z',
  ...over,
});

export const slackBot = (over: Partial<SlackBot> = {}): SlackBot => ({
  id: 'slack',
  label: 'Slack bot',
  status: 'on',
  reason: 'Its bot API key was used recently',
  botUsers: [{ id: 'b2', name: 'Slacky', email: 'slacky@bots.test', lastUsedAt: '2026-10-29T09:59:00.000Z' }],
  notificationKinds: ['job.awaiting_review', 'budget.hard'],
  ...over,
});

export const agentTools = (over: Partial<AgentTools> = {}): AgentTools => ({
  agent: 'verfijner',
  kind: 'allowlist',
  tools: [
    { name: 'listSpecs', description: 'List the specs of a project.', access: 'read', needsApproval: false },
    { name: 'saveRefinedSpec', description: 'Save the draft spec.', access: 'write', needsApproval: false },
  ],
  note: 'Unattended and bound to one intake item.',
  projectTools: [],
  ...over,
});

export const runSummary = (over: Partial<AgentRunSummary> = {}): AgentRunSummary => ({
  id: 'r1', agentId: 'verfijner', triggerKind: 'intake_item', triggerRefType: 'intake_item', triggerRefId: 'i1', actorUserId: 'b1', projectId: 'p1',
  startedAt: '2026-10-29T09:00:00.000Z', endedAt: '2026-10-29T09:01:00.000Z', outcome: 'ok', reason: null, model: 'openai/gpt-5-mini',
  inputTokens: 100, outputTokens: 10, costUsd: 0.01, linkedTable: null, linkedId: null, toolCallCount: 2, executor: null, metadataOnly: false,
  ...over,
});

export const runDetail = (over: Partial<AgentRunDetail> = {}): AgentRunDetail => ({
  ...runSummary(),
  toolCalls: [
    { id: 't1', toolName: 'listSpecs', input: '{"project":"p1"}', output: '[]', durationMs: 12, error: null, createdAt: '2026-10-29T09:00:10.000Z' },
    { id: 't2', toolName: 'saveRefinedSpec', input: '<script>alert(1)</script>', output: null, durationMs: null, error: '<img src=x onerror=alert(1)>', createdAt: '2026-10-29T09:00:20.000Z' },
  ],
  ...over,
});

export const agentPrompt = (over: Partial<AgentPrompt> = {}): AgentPrompt => ({
  agent: 'verfijner',
  kind: 'instructions',
  exampleBinding: 'Example binding: a made-up intake item.',
  instructions: { label: 'Instructions', text: 'You are Verfijner.\n<b>not bold</b>', version: 'abc123def456', length: 36 },
  runPrompt: { label: 'Run prompt', text: 'Refine GitHub issue #123', version: '111111111111', length: 24 },
  file: {
    path: 'apps/api/src/copilot/verfijner.instructions.ts',
    url: 'https://github.com/Gilde-dev/gilde/blob/0123456789abcdef0123/apps/api/src/copilot/verfijner.instructions.ts',
    ref: '0123456789abcdef0123', refKind: 'commit', refSource: 'the commit of the running build, from GILDE_COMMIT_SHA',
  },
  settings: { dailyLimit: 10 },
  coding: null,
  note: null,
  ...over,
});
