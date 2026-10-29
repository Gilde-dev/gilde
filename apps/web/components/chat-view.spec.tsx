import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type CopilotThread, type CopilotThreadMessages } from '@/lib/api';

const agent = vi.hoisted(() => ({ threadId: '', setMessages: vi.fn() }));
const chat = vi.hoisted(() => ({ onInProgress: undefined as ((b: boolean) => void) | undefined }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/chat',
  useSearchParams: () => new URLSearchParams('project=p1'),
}));
vi.mock('@copilotkit/react-core/v2/headless', () => ({
  useAgent: () => ({ agent }),
  CopilotChatConfigurationProvider: ({ children, threadId, agentId }: { children: React.ReactNode; threadId: string; agentId: string }) => (
    <div data-testid="config" data-thread={threadId} data-agent={agentId}>{children}</div>
  ),
}));
vi.mock('@copilotkit/react-ui', () => ({
  CopilotChat: ({ onInProgress }: { onInProgress: (b: boolean) => void }) => {
    chat.onInProgress = onInProgress;
    return <div data-testid="chat" />;
  },
}));
vi.mock('@/components/copilot-tool-renderers', () => ({ GroupedMessage: () => null }));
vi.mock('@/components/copilot-provider', () => ({ COPILOT_AGENT: 'gilde', CopilotPageContext: () => null }));

import { ChatView, toAgentMessages } from './chat-view';

const threads: CopilotThread[] = [
  { id: 't2', title: 'Newest question', createdAt: '2026-03-02T10:00:00.000Z', updatedAt: '2026-03-02T10:00:00.000Z' },
  { id: 't1', title: 'Older question', createdAt: '2026-03-01T10:00:00.000Z', updatedAt: '2026-03-01T10:00:00.000Z' },
];
const history: CopilotThreadMessages = {
  thread: threads[1],
  messages: [
    { id: 'm1', role: 'user', content: 'How many jobs?' },
    { id: 'm2', role: 'assistant', content: 'Checking', toolCalls: [{ id: 'c1', name: 'listJobs', arguments: '{}' }] },
    { id: 'm2:c1', role: 'tool', toolCallId: 'c1', content: '[]' },
  ],
};

beforeEach(() => {
  agent.setMessages.mockReset();
  vi.spyOn(api, 'copilotStatus').mockResolvedValue({ enabled: true, model: 'openai/m', scout: { enabled: false, model: null }, refine: { enabled: false, model: null } });
  vi.spyOn(api, 'listCopilotThreads').mockResolvedValue(threads);
  vi.spyOn(api, 'getCopilotThread').mockResolvedValue(history);
  vi.spyOn(api, 'listProjects').mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe('ChatView', () => {
  it('lists the conversations in the order the API returns them and starts with an empty new conversation', async () => {
    render(<ChatView />);
    const nav = await screen.findByRole('navigation', { name: 'Conversations' });
    const items = within(nav).getAllByRole('button');
    expect(items.map((b) => b.getAttribute('title'))).toEqual(['Newest question', 'Older question']);
    expect(items.some((b) => b.hasAttribute('aria-current'))).toBe(false);
    expect(await screen.findByTestId('chat')).toBeInTheDocument();
    expect(api.getCopilotThread).not.toHaveBeenCalled();
    expect(agent.setMessages).toHaveBeenCalledWith([]);
  });

  it('opens a conversation: loads its messages into the chat, continues its thread and marks it active', async () => {
    render(<ChatView />);
    fireEvent.click(await screen.findByRole('button', { name: /Older question/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Older question/ })).toHaveAttribute('aria-current', 'page'));
    expect(await screen.findByTestId('config')).toHaveAttribute('data-thread', 't1');
    expect(screen.getByTestId('config')).toHaveAttribute('data-agent', 'gilde');
    expect(api.getCopilotThread).toHaveBeenCalledWith('t1');
    expect(agent.threadId).toBe('t1');
    expect(agent.setMessages).toHaveBeenLastCalledWith([
      { id: 'm1', role: 'user', content: 'How many jobs?' },
      { id: 'm2', role: 'assistant', content: 'Checking', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'listJobs', arguments: '{}' } }] },
      { id: 'm2:c1', role: 'tool', toolCallId: 'c1', content: '[]' },
    ]);
  });

  it('New conversation starts an empty thread with a fresh id', async () => {
    render(<ChatView />);
    fireEvent.click(await screen.findByRole('button', { name: /Older question/ }));
    await waitFor(() => expect(screen.getByTestId('config')).toHaveAttribute('data-thread', 't1'));
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    await waitFor(() => expect(screen.getByTestId('config').getAttribute('data-thread')).not.toBe('t1'));
    expect(agent.setMessages).toHaveBeenLastCalledWith([]);
    expect(within(screen.getByRole('navigation', { name: 'Conversations' })).queryByRole('button', { current: 'page' })).toBeNull();
  });

  it('refreshes the list when a run finishes', async () => {
    render(<ChatView />);
    await screen.findByTestId('chat');
    const calls = vi.mocked(api.listCopilotThreads).mock.calls.length;
    chat.onInProgress?.(true);
    expect(api.listCopilotThreads).toHaveBeenCalledTimes(calls);
    chat.onInProgress?.(false);
    await waitFor(() => expect(api.listCopilotThreads).toHaveBeenCalledTimes(calls + 1));
  });

  it('shows an empty state without conversations', async () => {
    vi.spyOn(api, 'listCopilotThreads').mockResolvedValue([]);
    render(<ChatView />);
    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeInTheDocument();
  });

  it('shows a skeleton while the list loads', async () => {
    vi.spyOn(api, 'listCopilotThreads').mockReturnValue(new Promise(() => {}));
    render(<ChatView />);
    expect(await screen.findByRole('status', { name: 'Loading conversations' })).toBeInTheDocument();
  });

  it('shows an error with retry when the list fails', async () => {
    const list = vi.spyOn(api, 'listCopilotThreads').mockRejectedValueOnce(new Error('boom'));
    render(<ChatView />);
    expect(await screen.findByText('Could not load conversations')).toBeInTheDocument();
    list.mockResolvedValue(threads);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('navigation', { name: 'Conversations' })).toBeInTheDocument();
  });

  it('shows an error with retry when a conversation fails to load', async () => {
    const get = vi.spyOn(api, 'getCopilotThread').mockRejectedValueOnce(new Error('gone'));
    render(<ChatView />);
    fireEvent.click(await screen.findByRole('button', { name: /Older question/ }));
    expect(await screen.findByText('Could not load this conversation')).toBeInTheDocument();
    expect(screen.queryByTestId('chat')).not.toBeInTheDocument();
    get.mockResolvedValue(history);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('chat')).toBeInTheDocument();
  });

  it('below md the list sits behind a Conversations button', async () => {
    render(<ChatView />);
    const aside = await screen.findByRole('complementary', { name: 'Conversation list', hidden: true });
    expect(aside).toHaveClass('hidden', 'md:block');
    fireEvent.click(screen.getByRole('button', { name: 'Conversations' }));
    expect(aside).toHaveClass('block');
    fireEvent.click(within(aside).getByRole('button', { name: /Older question/ }));
    expect(aside).toHaveClass('hidden');
  });

  it('shows the disabled note instead of a chat when the co-pilot is not configured', async () => {
    vi.spyOn(api, 'copilotStatus').mockResolvedValue({ enabled: false, model: null, scout: { enabled: false, model: null }, refine: { enabled: false, model: null } });
    render(<ChatView />);
    expect(await screen.findByText('Co-pilot not configured')).toBeInTheDocument();
    expect(screen.queryByTestId('chat')).not.toBeInTheDocument();
    expect(api.listCopilotThreads).not.toHaveBeenCalled();
  });
});

describe('toAgentMessages', () => {
  it('keeps assistant messages without tool calls free of a toolCalls key', () => {
    expect(toAgentMessages([{ id: 'a', role: 'assistant', content: 'hi' }])).toEqual([{ id: 'a', role: 'assistant', content: 'hi' }]);
  });
});
