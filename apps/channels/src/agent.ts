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
 * Asks the API who owns the API key. Fails with a message that never contains the key.
 */
export async function fetchBotUserId(config: Pick<ChannelsConfig, 'apiUrl' | 'apiKey'>): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${config.apiUrl}/v1/auth/me`, { headers: { Authorization: `Bearer ${config.apiKey}` } });
  } catch {
    throw new Error(`Cannot reach the Gilde API at ${config.apiUrl} (is it running and is GILDE_API_URL correct?)`);
  }
  if (response.status === 401) {
    throw new Error('GILDE_API_KEY was rejected by the Gilde API (401): the API key is invalid');
  }
  if (!response.ok) {
    throw new Error(`Cannot reach the Gilde API at ${config.apiUrl}: GET /v1/auth/me answered ${response.status}`);
  }
  const body: unknown = await response.json().catch(() => null);
  const id = typeof body === 'object' && body !== null && 'id' in body ? (body as { id: unknown }).id : undefined;
  if (typeof id !== 'string' || id === '') {
    throw new Error('The Gilde API returned no user id for GILDE_API_KEY (GET /v1/auth/me)');
  }
  return id;
}

/**
 * The remote gilde co-pilot. The resourceId (memory owner) must be the id of the API key owner,
 * because the API rejects any other resource with 403.
 */
export async function createCopilotAgent(config: Pick<ChannelsConfig, 'apiUrl' | 'apiKey'>): Promise<AbstractAgent> {
  const resourceId = await fetchBotUserId(config);
  const agents = await getRemoteAgents({ mastraClient: createMastraClient(config), resourceId });
  const agent = agents[COPILOT_AGENT_ID];
  if (!agent) {
    throw new Error(`Agent "${COPILOT_AGENT_ID}" not found at ${config.apiUrl}/v1/mastra (is the co-pilot configured in the API?)`);
  }
  return agent;
}
