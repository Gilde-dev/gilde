import type { PlatformAdapter } from '@copilotkit/channels';
import { slack } from '@copilotkit/channels/slack';

import type { ChannelsConfig } from './config.js';

export interface AdapterEntry {
  name: string;
  /** Returns the adapter when its credentials are configured, otherwise undefined. */
  create(config: ChannelsConfig): PlatformAdapter | undefined;
}

/** One entry per platform; add Teams or others here. */
export const ADAPTER_ENTRIES: AdapterEntry[] = [
  {
    name: 'slack',
    create: ({ slack: credentials }) => (credentials ? slack({ botToken: credentials.botToken, appToken: credentials.appToken }) : undefined),
  },
];

export function selectAdapters(config: ChannelsConfig, entries: AdapterEntry[] = ADAPTER_ENTRIES): { name: string; adapter: PlatformAdapter }[] {
  return entries.flatMap((entry) => {
    const adapter = entry.create(config);
    return adapter ? [{ name: entry.name, adapter }] : [];
  });
}
