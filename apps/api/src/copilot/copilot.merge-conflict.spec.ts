import { MCP_TOOL_NAMES } from '../mcp/mcp.tools.js';
import { compactJob } from './copilot.tool-bodies.js';
import { SCOUT_TOOL_NAMES } from './verkenner.tools.js';

describe('merge conflicts in co-pilot, MCP and scout reads', () => {
    it('lists the conflict flag of a job', () => {
        expect(compactJob({ id: 'j', mergeConflict: true } as never)).toMatchObject({ mergeConflict: true });
    });

    it('offers no tool that starts a conflict-fix round to MCP operators or the scout', () => {
        for (const names of [MCP_TOOL_NAMES, SCOUT_TOOL_NAMES]) {
            expect([...names].filter((n) => /conflict/i.test(n))).toEqual([]);
        }
    });
});
