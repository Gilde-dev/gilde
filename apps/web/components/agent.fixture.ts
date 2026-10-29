import type { Agent, AgentTools, SlackBot } from '@/lib/api';

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
