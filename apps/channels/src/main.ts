import { createChannel } from '@copilotkit/channels';

import { selectAdapters } from './adapters.js';
import { createCopilotAgent } from './agent.js';
import { loadConfig, type ChannelsConfig } from './config.js';
import { createNotificationWorker } from './notifications/index.js';

const NO_ADAPTERS = 'No channel adapters configured (set SLACK_BOT_TOKEN and SLACK_APP_TOKEN)';

type Stoppable = { stop(): Promise<void> };

/** Starts the mention/thread chat. Needs the co-pilot agent and Socket Mode. */
async function startChat(config: ChannelsConfig): Promise<Stoppable | undefined> {
  const adapters = selectAdapters(config);
  if (adapters.length === 0) return undefined;

  const channel = createChannel({
    name: 'gilde',
    // The channel acts as the bot user of the API key; chat users are not mapped to Gilde users yet.
    identifyUser: 'platform',
    agent: await createCopilotAgent(config),
    adapters: adapters.map((entry) => entry.adapter),
  });
  channel.onMention(async ({ thread }) => {
    await thread.runAgent();
  });

  // Channels have no public start(); the runtime seam is what CopilotKit's own runner calls.
  await channel.ɵruntime.start();
  console.log(`Gilde channels running: ${adapters.map((entry) => entry.name).join(', ')} -> ${config.apiUrl}`);
  return { stop: () => channel.ɵruntime.stop() };
}

async function main(): Promise<void> {
  const config = loadConfig();
  // Notifications run on their own: no co-pilot agent, no Socket Mode, and a chat failure does not stop them.
  const worker = createNotificationWorker(config);
  worker?.start();
  if (worker) console.log(`Gilde notifications running -> ${config.apiUrl}`);

  let chat: Stoppable | undefined;
  try {
    chat = await startChat(config);
  } catch (error) {
    if (!worker) throw error;
    console.error(`Chat failed to start, notifications keep running: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  if (!chat && !worker) {
    console.log(NO_ADAPTERS);
    return;
  }

  const stop = () => {
    void Promise.allSettled([worker?.stop(), chat?.stop()]).finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error: unknown) => {
  // Config errors list variable names only; for other errors print the message, not the object (it may carry request headers).
  console.error(error instanceof Error ? error.message : 'Gilde channels failed to start');
  process.exit(1);
});
