import { createChannel } from '@copilotkit/channels';

import { selectAdapters } from './adapters.js';
import { createCopilotAgent } from './agent.js';
import { loadConfig } from './config.js';

const NO_ADAPTERS = 'No channel adapters configured (set SLACK_BOT_TOKEN and SLACK_APP_TOKEN)';

async function main(): Promise<void> {
  const config = loadConfig();
  const adapters = selectAdapters(config);
  if (adapters.length === 0) {
    console.log(NO_ADAPTERS);
    return;
  }

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

  const stop = () => {
    void channel.ɵruntime.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error: unknown) => {
  // Config errors list variable names only; for other errors print the message, not the object (it may carry request headers).
  console.error(error instanceof Error ? error.message : 'Gilde channels failed to start');
  process.exit(1);
});
