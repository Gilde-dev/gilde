import type { Agent, AgentId } from '@/lib/api';

export type AgentRowId = AgentId | 'slack';

/** What starts a run of each agent, in words (the summary hour of the Verkenner comes from its settings). */
export function triggerText(id: AgentRowId, agent?: Pick<Agent, 'settings'>): string {
  switch (id) {
    case 'gilde':
      return 'Chat requests from signed-in users';
    case 'verkenner': {
      const hour = agent?.settings.summaryHourUtc;
      return `Signals from the factory, and a daily summary${hour === undefined ? '' : ` at ${String(hour).padStart(2, '0')}:00 UTC`}`;
    }
    case 'verfijner':
      return 'Labelled GitHub issues (intake items)';
    case 'werkmeester':
      return 'Approved spec versions of projects with auto-plan';
    case 'mcp':
      return 'MCP tool calls by operators';
    case 'coding':
      return 'Dispatch of queued jobs to an executor';
    case 'slack':
      return 'Chat messages in Slack and factory notifications';
  }
}

/** The limits of an agent as short "label: value" texts, from its field definitions and current settings. */
export function limitTexts(agent: Pick<Agent, 'fields' | 'settings'>): string[] {
  return agent.fields.map((f) => `${f.label}: ${agent.settings[f.key] ?? f.default}`);
}

/** Start of the current UTC day, the window of "today" on the overview. */
export function startOfUtcDay(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}
