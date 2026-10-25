import type { AbstractAgent } from '@ag-ui/client';
import { getRemoteAgents } from '@ag-ui/mastra';
import { MastraClient } from '@mastra/client-js';

import type { ChannelsConfig } from './config.js';

export const COPILOT_AGENT_ID = 'gilde';

/** Mastra's client adds its apiPrefix to every path; the API mounts the routes directly under /v1/mastra. */
export function createMastraClient(config: Pick<ChannelsConfig, 'apiUrl' | 'apiKey'>): MastraClient {
  return new MastraClient({
    baseUrl: `${config.apiUrl}/v1/mastra`,
    apiPrefix: '',
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
}

/**
 * The remote gilde co-pilot. The API scopes tools and memory to the owner of the API key,
 * so the resourceId sent here is only a placeholder.
 */
export async function createCopilotAgent(config: Pick<ChannelsConfig, 'apiUrl' | 'apiKey'>): Promise<AbstractAgent> {
  const agents = await getRemoteAgents({ mastraClient: createMastraClient(config), resourceId: 'channels' });
  const agent = agents[COPILOT_AGENT_ID];
  if (!agent) {
    throw new Error(`Agent "${COPILOT_AGENT_ID}" not found at ${config.apiUrl}/v1/mastra (is the co-pilot configured in the API?)`);
  }
  return agent;
}
