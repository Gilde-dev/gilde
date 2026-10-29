import { describe, expect, it } from 'vitest';

import { REFINE_TOOL_NAMES } from '../copilot/verfijner.tools.js';
import { SCOUT_TOOL_NAMES } from '../copilot/verkenner.tools.js';
import { PLAN_TOOL_NAMES } from '../copilot/werkmeester.tools.js';
import { MCP_TOOL_NAMES } from '../mcp/mcp.tools.js';

import { AGENT_IDS } from './agent-ids.js';
import { toolsOf, UNATTENDED_WRITE_TOOLS } from './agent-tools.js';

const names = (agent: (typeof AGENT_IDS)[number]) => (toolsOf(agent) ?? []).map((t) => t.name).sort();

describe('toolsOf', () => {
    it('lists exactly the allowlist constants of the unattended agents and the MCP server', () => {
        expect(names('verkenner')).toEqual([...SCOUT_TOOL_NAMES].sort());
        expect(names('verfijner')).toEqual([...REFINE_TOOL_NAMES].sort());
        expect(names('werkmeester')).toEqual([...PLAN_TOOL_NAMES].sort());
        expect(names('mcp')).toEqual([...MCP_TOOL_NAMES].sort());
    });

    it('marks only the declared writes as writes, and each declared write is a real tool', () => {
        for (const [agent, writes] of Object.entries(UNATTENDED_WRITE_TOOLS)) {
            const tools = toolsOf(agent as (typeof AGENT_IDS)[number])!;
            expect(tools.filter((t) => t.access === 'write').map((t) => t.name)).toEqual([...writes]);
            expect(tools.some((t) => t.needsApproval)).toBe(false);
        }
    });

    it('lists the co-pilot tools that need the user\'s confirmation as writes needing approval', () => {
        const tools = toolsOf('gilde')!;
        const writes = tools.filter((t) => t.access === 'write').map((t) => t.name).sort();
        expect(writes).toEqual(['createJob', 'createPlannedFeature', 'draftSpec']);
        expect(tools.every((t) => t.needsApproval === (t.access === 'write'))).toBe(true);
        expect(tools.find((t) => t.name === 'validateJob')?.access).toBe('read');
        expect(tools.length).toBeGreaterThan(20);
    });

    it('marks the MCP writes from the tool annotations, without the shared boundary text', () => {
        const tools = toolsOf('mcp')!;
        expect(tools.filter((t) => t.access === 'write').map((t) => t.name).sort()).toEqual(['createJob', 'createPlannedFeature', 'draftSpec']);
        expect(tools.find((t) => t.name === 'getJob')?.description).not.toContain('MCP boundary');
    });

    it('has no Gilde-side tools for the coding agents', () => {
        expect(toolsOf('coding')).toBeNull();
    });
});
