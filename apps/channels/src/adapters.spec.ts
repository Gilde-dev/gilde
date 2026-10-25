import type { PlatformAdapter } from '@copilotkit/channels';

import { selectAdapters, type AdapterEntry } from './adapters.js';
import type { ChannelsConfig } from './config.js';

const base: ChannelsConfig = { apiUrl: 'http://localhost:4100/api', apiKey: 'gk_x' };

describe('selectAdapters', () => {
  it('enables no adapter without credentials', () => {
    expect(selectAdapters(base)).toEqual([]);
  });

  it('enables Slack when both tokens are set', () => {
    const selected = selectAdapters({ ...base, slack: { botToken: 'xoxb-1', appToken: 'xapp-1' } });
    expect(selected.map((entry) => entry.name)).toEqual(['slack']);
  });

  it('keeps only the entries that create an adapter', () => {
    const adapter = {} as PlatformAdapter;
    const entries: AdapterEntry[] = [
      { name: 'off', create: () => undefined },
      { name: 'on', create: () => adapter },
    ];
    expect(selectAdapters(base, entries)).toEqual([{ name: 'on', adapter }]);
  });
});
