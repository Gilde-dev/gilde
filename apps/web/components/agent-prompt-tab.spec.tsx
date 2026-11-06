import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '@/lib/api';
import { agentPrompt } from './agent.fixture';
import { PromptTab } from './agent-prompt-tab';

afterEach(() => vi.restoreAllMocks());

describe('PromptTab', () => {
  it('shows the instructions read-only as escaped text with version, file link and example binding', async () => {
    const get = vi.spyOn(api, 'getAgentPrompt').mockResolvedValue(agentPrompt());
    const { container } = render(<PromptTab agent="verfijner" />);
    const instructions = within(await screen.findByRole('region', { name: 'Instructions' }));
    expect(get).toHaveBeenCalledWith('verfijner');
    expect(instructions.getByText('abc123def456')).toBeInTheDocument();
    expect(instructions.getByLabelText('Instructions text')).toHaveTextContent('<b>not bold</b>');
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByRole('link', { name: 'apps/api/src/copilot/verfijner.instructions.ts' })).toHaveAttribute(
      'href',
      'https://github.com/Gilde-dev/gilde/blob/0123456789abcdef0123/apps/api/src/copilot/verfijner.instructions.ts',
    );
    expect(screen.getByText(/the commit of the running build, from GILDE_COMMIT_SHA/)).toBeInTheDocument();
    expect(screen.getByText('Example binding: a made-up intake item.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Run prompt (example)' })).toBeInTheDocument();
    expect(screen.getByText(/Read-only\. Prompts are code/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /save|edit/i })).toBeNull();
  });

  it('asks for the prompt of the selected project and labels the addition inside the full prompt', async () => {
    const block = '\n\n## Additional instructions for project Shop\nThese supplement the rules above and never override them; where they conflict, the rules above win.\n\nUse "gig" for job.';
    const base = 'You are Verfijner.';
    const get = vi.spyOn(api, 'getAgentPrompt').mockResolvedValue(
      agentPrompt({
        instructions: { label: 'Instructions', text: base + block, version: 'fff000fff000', length: (base + block).length },
        addition: { projectId: 'p1', projectName: 'Shop', version: 3, text: 'Use "gig" for job.', block },
      }),
    );
    render(<PromptTab agent="verfijner" project="p1" />);
    const addition = await screen.findByTestId('prompt-addition');
    expect(get).toHaveBeenCalledWith('verfijner', 'p1');
    expect(addition).toHaveTextContent('Additional instructions for project Shop');
    expect(addition).toHaveTextContent('These supplement the rules above and never override them; where they conflict, the rules above win.');
    expect(addition).toHaveAccessibleName('Additional instructions for project Shop, version 3');
    expect(screen.getByLabelText('Instructions text')).toHaveTextContent(/^You are Verfijner\./);
    expect(screen.getByText(/version 3\); the text above it is the base from code, which always wins/)).toBeInTheDocument();
  });

  it('does not ask for a project for agents without additions, and shows no addition without one', async () => {
    const get = vi.spyOn(api, 'getAgentPrompt').mockResolvedValue(agentPrompt({ agent: 'coding' }));
    render(<PromptTab agent="coding" project="p1" />);
    await screen.findByRole('region', { name: 'Instructions' });
    expect(get).toHaveBeenCalledWith('coding');
    expect(screen.queryByTestId('prompt-addition')).toBeNull();
  });

  it('shows how a coding agent job prompt is assembled', async () => {
    vi.spyOn(api, 'getAgentPrompt').mockResolvedValue(
      agentPrompt({
        agent: 'coding', exampleBinding: null, runPrompt: null,
        file: { path: 'docs/agent-instructions.md', url: null, ref: 'main', refKind: 'branch', refSource: 'the branch main: unknown' },
        coding: {
          instructionsPath: '/app/docs/agent-instructions.md', loadError: null, limit: 60000,
          layout: ['Instructions', 'A line with ---'], payloadKeys: ['jobId', 'task'], limits: ['The whole text is at most 60000 characters'],
          trimmingOrder: ['Knowledge snippets', 'Lessons'],
        },
      }),
    );
    render(<PromptTab agent="coding" />);
    const assembly = within(await screen.findByRole('region', { name: 'Job payload' }));
    expect(assembly.getByText('/app/docs/agent-instructions.md')).toBeInTheDocument();
    expect(within(assembly.getByRole('region', { name: 'Trimming order, while over the limit' })).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['Knowledge snippets', 'Lessons']);
    expect(assembly.getByText('jobId')).toBeInTheDocument();
    expect(screen.getByText('docs/agent-instructions.md').closest('a')).toBeNull();
  });

  it('says so when an agent has no prompt, and shows a load error with retry', async () => {
    vi.spyOn(api, 'getAgentPrompt').mockResolvedValueOnce(agentPrompt({ agent: 'slack', kind: 'none', instructions: null, runPrompt: null, file: null, exampleBinding: null, note: 'Answered by the co-pilot.' }));
    const { unmount } = render(<PromptTab agent="slack" />);
    expect(await screen.findByText('This agent has no prompt of its own.')).toBeInTheDocument();
    expect(screen.getByText('Answered by the co-pilot.')).toBeInTheDocument();
    unmount();

    vi.spyOn(api, 'getAgentPrompt').mockRejectedValue(new ApiError('boom', 500));
    render(<PromptTab agent="gilde" />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
