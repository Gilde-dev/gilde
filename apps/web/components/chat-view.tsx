'use client';

import { CopilotChatConfigurationProvider, useAgent } from '@copilotkit/react-core/v2/headless';
import { CopilotChat } from '@copilotkit/react-ui';
import { MessageSquare, MessageSquarePlus, PanelLeftOpen, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { CopilotPageContext, COPILOT_AGENT } from '@/components/copilot-provider';
import { GroupedMessage } from '@/components/copilot-tool-renderers';
import { api, type CopilotThread, type CopilotThreadMessage } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { useProject } from '@/lib/use-project';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';
import { Icon } from './ui/icon';
import { Skeleton } from './ui/skeleton';

const POLL_MS = 30_000;

/** A conversation open in the chat. `saved` is false for a new one: nothing to load, and not in the list yet. */
interface Selection {
  id: string;
  saved: boolean;
}

const newConversation = (): Selection => ({ id: crypto.randomUUID(), saved: false });

/** The history in the shape the chat (AG-UI) takes: assistant messages carry their tool calls, tool results follow. */
export function toAgentMessages(messages: CopilotThreadMessage[]) {
  return messages.map((m) => {
    if (m.role === 'tool') return { id: m.id, role: 'tool' as const, toolCallId: m.toolCallId ?? '', content: m.content };
    if (m.role === 'assistant') {
      return {
        id: m.id,
        role: 'assistant' as const,
        content: m.content,
        ...(m.toolCalls?.length && {
          toolCalls: m.toolCalls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.arguments } })),
        }),
      };
    }
    return { id: m.id, role: 'user' as const, content: m.content };
  });
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function ErrorNote({ title, error, onRetry }: { title: string; error: Error; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 p-8 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-danger-soft text-danger">
        <Icon icon={TriangleAlert} size={20} />
      </span>
      <p className="text-md font-semibold">{title}</p>
      <p className="text-sm text-muted-foreground">{errorMessage(error)}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function ConversationList({
  threads,
  activeId,
  onSelect,
  onNew,
}: {
  threads: { data: CopilotThread[] | undefined; error: Error | null; loading: boolean; refresh: () => Promise<void> };
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const { data, error, loading, refresh } = threads;
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <Button variant="outline" icon={MessageSquarePlus} onClick={onNew} className="w-full">
        New conversation
      </Button>
      {loading && !data ? (
        <div role="status" aria-label="Loading conversations" className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : error && !data ? (
        <ErrorNote title="Could not load conversations" error={error} onRetry={() => void refresh()} />
      ) : data && data.length === 0 ? (
        <EmptyState icon={MessageSquare} title="No conversations yet" text="Ask the co-pilot something to start one." className="p-4" />
      ) : (
        <nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto">
          <ul className="flex flex-col gap-0.5">
            {data?.map((t) => {
              const active = t.id === activeId;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    title={t.title}
                    onClick={() => onSelect(t.id)}
                    className={cn(
                      'flex w-full flex-col rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <span className="truncate text-md">{t.title}</span>
                    <time dateTime={t.updatedAt} className="text-label text-muted-foreground">
                      {new Date(t.updatedAt).toLocaleString()}
                    </time>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
    </div>
  );
}

/** Puts the conversation's earlier messages into the agent before the chat mounts, so the thread continues where it ended. */
function ChatThread({ threadId, history, onRunFinished }: { threadId: string; history: CopilotThreadMessage[]; onRunFinished: () => void }) {
  const { agent } = useAgent({ agentId: COPILOT_AGENT });
  const [ready, setReady] = useState(false);
  useEffect(() => {
    agent.threadId = threadId;
    agent.setMessages(toAgentMessages(history) as never);
    setReady(true);
    // Only when the conversation changes: later messages of this run are the agent's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, agent]);
  if (!ready) return null;
  return (
    <CopilotChatConfigurationProvider agentId={COPILOT_AGENT} threadId={threadId}>
      <CopilotChat
        className="h-full"
        labels={{ title: 'Gilde co-pilot' }}
        RenderMessage={GroupedMessage}
        onInProgress={(inProgress) => {
          if (!inProgress) onRunFinished();
        }}
      />
    </CopilotChatConfigurationProvider>
  );
}

function ChatPane({ selection, onRunFinished }: { selection: Selection; onRunFinished: () => void }) {
  const load = useCallback(
    () => (selection.saved ? api.getCopilotThread(selection.id) : Promise.resolve(null)),
    [selection.id, selection.saved],
  );
  const { data, error, loading, refresh } = usePolling(load, 24 * 3600_000);
  if (error && !data) return <ErrorNote title="Could not load this conversation" error={error} onRetry={() => void refresh()} />;
  if (loading || data === undefined) {
    return (
      <div role="status" aria-label="Loading conversation" className="flex flex-col gap-3 p-6">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="ml-auto h-10 w-1/2" />
        <Skeleton className="h-16 w-3/4" />
      </div>
    );
  }
  return <ChatThread key={selection.id} threadId={selection.id} history={data?.messages ?? []} onRunFinished={onRunFinished} />;
}

/** Full-page chat with the co-pilot, next to the user's earlier conversations. */
export function ChatView() {
  const { projectId } = useProject();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [selection, setSelection] = useState<Selection>(newConversation);
  const [listOpen, setListOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .copilotStatus()
      .then((s) => !cancelled && setEnabled(s.enabled))
      .catch(() => !cancelled && setEnabled(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchThreads = useCallback(() => (enabled ? api.listCopilotThreads() : Promise.resolve([] as CopilotThread[])), [enabled]);
  const threads = usePolling(fetchThreads, POLL_MS);

  if (enabled === null) {
    return (
      <div role="status" aria-label="Loading chat" className="p-6">
        <Skeleton className="h-10 w-1/3" />
      </div>
    );
  }
  if (!enabled) {
    return (
      <div className="p-6">
        <EmptyState icon={MessageSquare} title="Co-pilot not configured" text="Set OPENAI_API_KEY and COPILOT_MODEL on the API to chat with the co-pilot." />
      </div>
    );
  }

  const select = (id: string) => {
    setSelection({ id, saved: true });
    setListOpen(false);
  };
  const start = () => {
    setSelection(newConversation());
    setListOpen(false);
  };

  return (
    <div className="flex h-[calc(100vh-5rem)] min-h-[28rem]">
      {projectId && <CopilotPageContext description="The project selected in the Gilde UI" value={{ projectId }} />}
      <aside
        aria-label="Conversation list"
        className={cn('w-full shrink-0 border-r border-border-subtle md:block md:w-72', listOpen ? 'block' : 'hidden')}
      >
        <ConversationList threads={threads} activeId={selection.id} onSelect={select} onNew={start} />
      </aside>
      <section aria-label="Chat" className={cn('min-w-0 flex-1 flex-col', listOpen ? 'hidden md:flex' : 'flex')}>
        <div className="border-b border-border-subtle p-2 md:hidden">
          <Button variant="ghost" size="sm" icon={PanelLeftOpen} aria-expanded={listOpen} onClick={() => setListOpen(true)}>
            Conversations
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <ChatPane selection={selection} onRunFinished={() => void threads.refresh()} />
        </div>
      </section>
    </div>
  );
}
