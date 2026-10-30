import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, type AgentAuditEntry } from '@/lib/api';
import { agent, agentPrompt, agentTools, runSummary, slackBot } from './agent.fixture';
import { AgentDetailView } from './agent-detail';

const nav = vi.hoisted(() => ({ params: { id: 'verfijner' } as Record<string, string> }));
vi.mock('next/navigation', () => ({
  useParams: () => nav.params,
  useSearchParams: () => new URLSearchParams('project=p1'),
  usePathname: () => '/agents/verfijner',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const audit = (over: Partial<AgentAuditEntry> = {}): AgentAuditEntry => ({
  id: 'a1', agent: 'verfijner', field: 'settings.dailyLimit', oldValue: '20', newValue: '10',
  changedBy: { id: 'u1', name: 'Pascal', email: 'p@x.test' }, createdAt: '2026-10-29T09:00:00.000Z', ...over,
});

beforeEach(() => {
  nav.params = { id: 'verfijner' };
  vi.spyOn(api, 'listAgentBotUsers').mockResolvedValue([
    { id: 'b1', name: 'Refiner', email: 'refiner@bots.test' },
    { id: 'b2', name: 'Planner', email: 'planner@bots.test' },
  ]);
  vi.spyOn(api, 'listAgentAudit').mockResolvedValue([]);
  vi.spyOn(api, 'me').mockResolvedValue({ id: 'u1', name: 'Pascal', email: 'pascal@gilde.test', isAdmin: true });
});
afterEach(() => vi.restoreAllMocks());

describe('AgentDetailView: Configuration', () => {
  it('shows the settings read-only with a note for non-admins', async () => {
    vi.spyOn(api, 'me').mockResolvedValue({ id: 'u2', name: 'Kim', email: 'kim@gilde.test', isAdmin: false });
    vi.spyOn(api, 'getAgent').mockResolvedValue(agent());
    render(<AgentDetailView />);
    expect(await screen.findByText('Only admins can change agent settings.')).toBeInTheDocument();
    const form = within(await screen.findByRole('form', { name: 'Settings' }));
    expect(form.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument();
    expect(form.getByLabelText('Runs per project per day')).toBeDisabled();
  });

  const reviewer = (over: Partial<Parameters<typeof agent>[0]> = {}) =>
    agent({
      id: 'reviewer', label: 'Reviewer', hasBotUser: false, botUserId: null, botUser: null,
      settings: { timeoutSeconds: 300, maxSteps: 12, maxInputTokens: 60000, maxOutputTokens: 4000, maxRevisions: 2 },
      fields: [
        { key: 'timeoutSeconds', label: 'Timeout per review (seconds)', kind: 'int', min: 1, max: 9007199254740991, default: 300 },
        { key: 'maxSteps', label: 'Maximum steps per review', kind: 'int', min: 1, max: 9007199254740991, default: 12 },
        { key: 'maxInputTokens', label: 'Input tokens per review (all steps)', kind: 'int', min: 1, max: 9007199254740991, default: 60000 },
        { key: 'maxOutputTokens', label: 'Output tokens per review (all steps)', kind: 'int', min: 1, max: 9007199254740991, default: 4000 },
        { key: 'maxRevisions', label: 'Automatic revision rounds per job', kind: 'int', min: 1, max: 9007199254740991, default: 2 },
      ],
      ...over,
    });

  it('edits the five reviewer limits with a labelled timeout unit and shows field errors', async () => {
    nav.params = { id: 'reviewer' };
    vi.spyOn(api, 'getAgent').mockResolvedValue(reviewer());
    const put = vi.spyOn(api, 'replaceAgentSettings').mockResolvedValue(reviewer());
    render(<AgentDetailView />);
    const form = within(await screen.findByRole('form', { name: 'Settings' }));
    expect(form.getByLabelText('Timeout per review (seconds)')).toHaveValue(300);
    expect(form.getByLabelText('Maximum steps per review')).toHaveValue(12);
    expect(form.getByLabelText('Input tokens per review (all steps)')).toHaveValue(60000);
    expect(form.getByLabelText('Output tokens per review (all steps)')).toHaveValue(4000);
    expect(form.getByLabelText('Automatic revision rounds per job')).toHaveValue(2);
    expect(screen.getByText(/does not turn on automatic review for any project/)).toBeInTheDocument();

    fireEvent.change(form.getByLabelText('Timeout per review (seconds)'), { target: { value: '120' } });
    fireEvent.click(form.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('reviewer', expect.objectContaining({ botUserId: null, settings: { timeoutSeconds: 120, maxSteps: 12, maxInputTokens: 60000, maxOutputTokens: 4000, maxRevisions: 2 } })),
    );

    put.mockRejectedValueOnce(new ApiError('x', 400, 'Validation failed', [{ path: 'settings.maxSteps', message: 'Must be at least 1' }]));
    fireEvent.change(form.getByLabelText('Maximum steps per review'), { target: { value: '0' } });
    fireEvent.click(form.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Must be at least 1')).toBeInTheDocument();
  });

  it('shows distinct reasons for off, misconfigured and env-disabled reviewers', async () => {
    nav.params = { id: 'reviewer' };
    const cases = [
      { over: { status: 'off' as const, enabled: false, reason: 'The reviewer is switched off in the agent settings' }, text: /Off: The reviewer is switched off/ },
      { over: { status: 'misconfigured' as const, reason: 'No model is set (neither for this agent nor for the co-pilot)' }, text: /Misconfigured: No model is set/ },
      { over: { status: 'disabled_by_env' as const, reason: 'AGENTS_DISABLED names this agent' }, text: /Disabled by the environment: AGENTS_DISABLED/ },
    ];
    for (const c of cases) {
      vi.spyOn(api, 'getAgent').mockResolvedValue(reviewer(c.over));
      const { unmount } = render(<AgentDetailView />);
      expect(await screen.findByText(c.text)).toBeInTheDocument();
      unmount();
    }
  });

  it('shows the stored settings and saves a full replacement built from the loaded agent', async () => {
    vi.spyOn(api, 'getAgent').mockResolvedValue(agent());
    const put = vi.spyOn(api, 'replaceAgentSettings').mockResolvedValue(agent());
    render(<AgentDetailView />);
    const form = within(await screen.findByRole('form', { name: 'Settings' }));
    expect(form.getByLabelText('Enabled')).toBeChecked();
    expect(form.getByLabelText('Bot user')).toHaveValue('b1');
    expect(form.getByLabelText('Model')).toHaveValue('openai/gpt-5-mini');
    expect(form.getByLabelText('Runs per project per day')).toHaveValue(10);

    fireEvent.change(form.getByLabelText('Bot user'), { target: { value: 'b2' } });
    fireEvent.change(form.getByLabelText('Runs per project per day'), { target: { value: '15' } });
    fireEvent.click(form.getByLabelText('Enabled'));
    fireEvent.click(form.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('verfijner', { enabled: false, botUserId: 'b2', model: 'openai/gpt-5-mini', settings: { dailyLimit: 15 } }),
    );
    expect(await screen.findByText(/Saved\. The change is in effect now/)).toBeInTheDocument();
  });

  it('creates a bot user from the dialog, prefilled, and selects it without saving', async () => {
    vi.spyOn(api, 'getAgent').mockResolvedValue(agent({ id: 'werkmeester', label: 'Werkmeester' }));
    const create = vi.spyOn(api, 'createBotUser').mockResolvedValue({ id: 'b9', name: 'Werkmeester', email: 'werkmeester@gilde.test', isBot: true });
    const put = vi.spyOn(api, 'replaceAgentSettings').mockResolvedValue(agent());
    render(<AgentDetailView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create bot user' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByLabelText('Name')).toHaveValue('Werkmeester');
    await waitFor(() => expect(dialog.getByLabelText('Email')).toHaveValue('werkmeester@gilde.test'));
    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: 'Werkmeester', email: 'werkmeester@gilde.test' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Bot user')).toHaveValue('b9');
    expect(screen.getByRole('option', { name: 'Werkmeester (werkmeester@gilde.test)' })).toBeInTheDocument();
    expect(put).not.toHaveBeenCalled();
  });

  it('shows field errors and the 409 hint in the create bot dialog', async () => {
    vi.spyOn(api, 'getAgent').mockResolvedValue(agent());
    const create = vi.spyOn(api, 'createBotUser')
      .mockRejectedValueOnce(new ApiError('x', 400, 'Validation failed', [{ path: 'email', message: 'Invalid email address' }]))
      .mockRejectedValueOnce(new ApiError('x', 409, 'A user with email a@x.test already exists and is not a bot. Mark it as a bot with the CLI: pnpm --filter @gilde/api user:mark-bot --email a@x.test'));
    render(<AgentDetailView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create bot user' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));
    expect(await dialog.findByText('Invalid email address')).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('user:mark-bot --email a@x.test');
    expect(create).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Bot user')).toHaveValue('b1');
  });

  it('offers only bots from the picker, plus the stored one', async () => {
    vi.spyOn(api, 'getAgent').mockResolvedValue(agent({ botUserId: 'old', botUser: { id: 'old', name: 'Old', email: 'old@x.test' } }));
    render(<AgentDetailView />);
    const select = await screen.findByLabelText('Bot user');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'None', 'Refiner (refiner@bots.test)', 'Planner (planner@bots.test)', 'Old (old@x.test)',
    ]);
  });

  it('shows field errors next to the fields and nothing else', async () => {
    vi.spyOn(api, 'getAgent').mockResolvedValue(agent());
    vi.spyOn(api, 'replaceAgentSettings').mockRejectedValue(
      new ApiError('x', 400, 'Validation failed', [
        { path: 'settings.dailyLimit', message: 'Must be at least 1' },
        { path: 'model', message: 'Must be an OpenAI model id in the form openai/<model>' },
        { path: 'botUserId', message: 'Choose a user that is marked as a bot' },
      ]),
    );
    render(<AgentDetailView />);
    const form = within(await screen.findByRole('form', { name: 'Settings' }));
    fireEvent.change(form.getByLabelText('Runs per project per day'), { target: { value: '0' } });
    fireEvent.click(form.getByRole('button', { name: 'Save settings' }));
    expect(await form.findByText('Must be at least 1')).toBeInTheDocument();
    expect(form.getByText(/Must be an OpenAI model id/)).toBeInTheDocument();
    expect(form.getByText('Choose a user that is marked as a bot')).toBeInTheDocument();
    expect(form.getByLabelText('Runs per project per day')).toHaveAttribute('aria-invalid', 'true');
    expect(form.queryByText(/Only a signed-in person/)).not.toBeInTheDocument();
  });

  it('explains a 403 as human-only', async () => {
    vi.spyOn(api, 'getAgent').mockResolvedValue(agent());
    vi.spyOn(api, 'replaceAgentSettings').mockRejectedValue(new ApiError('x', 403, 'Forbidden'));
    render(<AgentDetailView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only a signed-in person can change agent settings. API keys and bot accounts cannot.');
  });

  it('shows an agent disabled by the environment read-only, with the reason', async () => {
    vi.spyOn(api, 'getAgent').mockResolvedValue(agent({ status: 'disabled_by_env', reason: 'AGENTS_DISABLED names this agent' }));
    render(<AgentDetailView />);
    expect(await screen.findByText(/Disabled by the environment: AGENTS_DISABLED names this agent/)).toBeInTheDocument();
    expect(await screen.findByLabelText('Runs per project per day')).toBeDisabled();
    expect(screen.getByLabelText('Enabled')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument();
  });

  it('shows why a misconfigured agent does not run', async () => {
    vi.spyOn(api, 'getAgent').mockResolvedValue(agent({ status: 'misconfigured', reason: 'The chosen bot user no longer exists' }));
    render(<AgentDetailView />);
    expect(await screen.findByText(/Misconfigured: The chosen bot user no longer exists/)).toBeInTheDocument();
  });

  it('lists the audit trail with who, field, old and new value', async () => {
    vi.spyOn(api, 'getAgent').mockResolvedValue(agent());
    vi.spyOn(api, 'listAgentAudit').mockResolvedValue([audit(), audit({ id: 'a2', field: 'enabled', oldValue: 'false', newValue: 'true', changedBy: { id: 'u9', name: null, email: null } })]);
    render(<AgentDetailView />);
    const trail = within(await screen.findByRole('region', { name: 'Audit trail' }));
    const row = within(await trail.findByRole('row', { name: /settings\.dailyLimit/ }));
    expect(row.getByText('Pascal')).toBeInTheDocument();
    expect(row.getByText('20')).toBeInTheDocument();
    expect(row.getByText('10')).toBeInTheDocument();
    expect(trail.getByText('u9')).toBeInTheDocument();
  });

  it('shows the dispatch lesson settings for coding agents, with no enabled switch and no bot or model', async () => {
    nav.params = { id: 'coding' };
    vi.spyOn(api, 'getAgent').mockResolvedValue(
      agent({ id: 'coding', label: 'Coding agents', hasBotUser: false, botUser: null, botUserId: null, hasModel: false, model: null, effectiveModel: null, settings: { lessonsTopK: 5 },
        fields: [{ key: 'lessonsTopK', label: 'Lessons per job', kind: 'int', min: 0, max: 5, default: 5 }] }),
    );
    const put = vi.spyOn(api, 'replaceAgentSettings').mockResolvedValue(agent());
    render(<AgentDetailView />);
    const form = within(await screen.findByRole('form', { name: 'Settings' }));
    expect(form.getByLabelText('Lessons per job')).toHaveValue(5);
    expect(form.queryByLabelText('Enabled')).not.toBeInTheDocument();
    expect(form.queryByLabelText('Bot user')).not.toBeInTheDocument();
    expect(form.queryByLabelText('Model')).not.toBeInTheDocument();
    expect(screen.getByText(/switched off per executor/)).toBeInTheDocument();
    fireEvent.click(form.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('coding', { enabled: true, botUserId: null, model: null, settings: { lessonsTopK: 5 } }));
  });

  it('shows loading and an error with retry', async () => {
    const get = vi.spyOn(api, 'getAgent').mockRejectedValueOnce(new ApiError('x', 500, 'Database is down'));
    render(<AgentDetailView />);
    expect(screen.getByRole('status', { name: 'Loading agent' })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Database is down');
    get.mockResolvedValue(agent());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('form', { name: 'Settings' })).toBeInTheDocument();
  });
});

describe('AgentDetailView: Tools', () => {
  const openTools = async () => fireEvent.click(await screen.findByRole('tab', { name: 'Tools' }));

  it('lists the allowlist with read/write and approval, and the attached project MCP tools', async () => {
    vi.spyOn(api, 'getAgent').mockResolvedValue(agent());
    vi.spyOn(api, 'getAgentTools').mockResolvedValue(
      agentTools({
        tools: [
          { name: 'listSpecs', description: 'List the specs.', access: 'read', needsApproval: false },
          { name: 'createJob', description: 'Create a triage job.', access: 'write', needsApproval: true },
          { name: 'proposePlan', description: 'Propose a plan.', access: 'write', needsApproval: false },
        ],
        projectTools: [{ projectId: 'p1', projectName: 'Shop', servers: [{ serverId: 's1', serverName: 'Docs', tools: [{ name: 'search', mode: 'read', needsApproval: false }, { name: 'post', mode: 'write', needsApproval: true }] }] }],
      }),
    );
    render(<AgentDetailView />);
    await openTools();
    const list = within(await screen.findByRole('region', { name: 'Tools' }));
    const item = (name: string) => within(list.getByText(name).closest('li')!);
    expect(item('listSpecs').getByText('Read')).toBeInTheDocument();
    expect(item('createJob').getByText('Write')).toBeInTheDocument();
    expect(item('createJob').getByText('Asks for confirmation')).toBeInTheDocument();
    expect(item('proposePlan').getByText('No confirmation')).toBeInTheDocument();
    const mcp = within(screen.getByRole('region', { name: 'Project MCP tools' }));
    expect(mcp.getByText('Shop')).toBeInTheDocument();
    expect(mcp.getByText('Docs')).toBeInTheDocument();
    expect(mcp.getByText('post').parentElement).toHaveTextContent('Asks for confirmation');
  });

  it('explains that coding agents use their routine\'s own tools', async () => {
    nav.params = { id: 'coding' };
    vi.spyOn(api, 'getAgent').mockResolvedValue(agent({ id: 'coding', label: 'Coding agents', hasBotUser: false, botUser: null, hasModel: false, fields: [] }));
    vi.spyOn(api, 'getAgentTools').mockResolvedValue(agentTools({ agent: 'coding', kind: 'routine', tools: [], note: 'Coding agents run in each user\'s own Claude Code routine and use the tools of that routine.' }));
    render(<AgentDetailView />);
    await openTools();
    expect(await screen.findByText(/use the tools of that routine/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Tools' })).not.toBeInTheDocument();
  });

  it('shows an error with retry', async () => {
    vi.spyOn(api, 'getAgent').mockResolvedValue(agent());
    vi.spyOn(api, 'getAgentTools').mockRejectedValue(new ApiError('x', 500, 'No tools today'));
    render(<AgentDetailView />);
    await openTools();
    expect(await screen.findByText('No tools today')).toBeInTheDocument();
  });
});

describe('AgentDetailView: Slack bot', () => {
  it('shows the bot account and the notification kinds on Configuration and Tools', async () => {
    nav.params = { id: 'slack' };
    vi.spyOn(api, 'getSlackBot').mockResolvedValue(slackBot());
    render(<AgentDetailView />);
    const account = within(await screen.findByRole('region', { name: 'Bot account' }));
    expect(account.getByText('slacky@bots.test')).toBeInTheDocument();
    const kinds = within(screen.getByRole('region', { name: 'Notification kinds' }));
    expect(kinds.getByText('job.awaiting_review')).toBeInTheDocument();
    expect(kinds.getByText('budget.hard')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }));
    expect(await screen.findByText(/no tools of its own/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Notification kinds' })).toBeInTheDocument();
  });
});

describe('AgentDetailView: Prompt and Activity tabs', () => {
  it('has Prompt and Activity tabs next to Configuration and Tools, loaded when opened', async () => {
    nav.params = { id: 'verfijner' };
    vi.spyOn(api, 'getAgent').mockResolvedValue(agent());
    const prompt = vi.spyOn(api, 'getAgentPrompt').mockResolvedValue(agentPrompt());
    vi.spyOn(api, 'listProjects').mockResolvedValue([]);
    vi.spyOn(api, 'listAgentRuns').mockResolvedValue({ items: [runSummary()], page: 1, pageSize: 25, total: 1 });
    render(<AgentDetailView />);
    const tabs = within(await screen.findByRole('tablist', { name: 'Agent sections' }));
    expect(tabs.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Configuration', 'Tools', 'Prompt', 'Activity']);
    expect(prompt).not.toHaveBeenCalled();
    fireEvent.click(tabs.getByRole('tab', { name: 'Prompt' }));
    expect(await screen.findByRole('region', { name: 'Instructions' })).toBeInTheDocument();
    fireEvent.click(tabs.getByRole('tab', { name: 'Activity' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('gives the Slack bot its own variants', async () => {
    nav.params = { id: 'slack' };
    vi.spyOn(api, 'getSlackBot').mockResolvedValue(slackBot());
    vi.spyOn(api, 'getAgentPrompt').mockResolvedValue(agentPrompt({ agent: 'slack', kind: 'none', instructions: null, runPrompt: null, file: null, exampleBinding: null, note: 'No prompt.' }));
    vi.spyOn(api, 'listSlackDeliveries').mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0 });
    render(<AgentDetailView />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Prompt' }));
    expect(await screen.findByText('No prompt.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(await screen.findByText('Nothing was delivered yet.')).toBeInTheDocument();
  });
});
