'use client';

import { useAgent, useRenderTool } from '@copilotkit/react-core/v2/headless';
import {
  AssistantMessage as DefaultAssistantMessage,
  CopilotSidebar,
  ImageRenderer as DefaultImageRenderer,
  UserMessage as DefaultUserMessage,
} from '@copilotkit/react-ui';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { PLAN_TOOL } from '@/components/copilot-plan-approval';
import type { JobStatus } from '@/lib/api';

export type ToolStatus = 'inProgress' | 'executing' | 'complete';

export interface ToolCallViewProps {
  name: string;
  parameters?: unknown;
  status: ToolStatus;
  result?: string;
}

type Args = Record<string, unknown>;

const RESULT_LINES = 6;

const STATUS_VARIANT: Record<JobStatus, 'success' | 'warning' | 'danger' | 'secondary' | 'outline' | 'default'> = {
  triage: 'secondary',
  queued: 'outline',
  dispatched: 'default',
  pr_open: 'default',
  awaiting_review: 'warning',
  merged: 'success',
  rejected: 'danger',
  parked: 'warning',
  cancelled: 'secondary',
};

const asArgs = (p: unknown): Args => (p && typeof p === 'object' && !Array.isArray(p) ? (p as Args) : {});

function parseResult(result: string | undefined): unknown {
  if (result === undefined) return undefined;
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

/** The message of a failed call: a thrown error comes back as `{ error }` or as text starting with "Error". */
export function toolError(result: string | undefined): string | null {
  const value = parseResult(result);
  if (typeof value === 'string') return /^error\b/i.test(value.trim()) ? value.trim() : null;
  if (value && typeof value === 'object' && 'error' in value) {
    const e = (value as { error: unknown }).error;
    return typeof e === 'string' ? e : JSON.stringify(e);
  }
  return null;
}

/** A short human label for a tool call; unknown tools show their name. */
export function toolLabel(name: string, parameters: unknown): string {
  const a = asArgs(parameters);
  switch (name) {
    case 'searchRepoCode':
      return 'Searching code';
    case 'readRepoFile': {
      const path = typeof a.path === 'string' ? a.path : '';
      const range = a.startLine !== undefined || a.endLine !== undefined ? ` lines ${a.startLine ?? 1}-${a.endLine ?? 'end'}` : '';
      return path ? `Reading ${path}${range}` : 'Reading a file';
    }
    case 'listRepoFiles':
      return 'Listing files';
    case 'listJobs':
      return 'Looking up jobs';
    case 'getJob':
      return 'Looking up a job';
    case 'listProjects':
      return 'Looking up projects';
    case 'listRepos':
      return 'Looking up repos';
    case 'listFeatures':
      return 'Looking up features';
    case 'getFeature':
      return 'Looking up a feature';
    case 'listProposals':
      return 'Looking up proposals';
    case 'listLessons':
      return 'Looking up lessons';
    case 'getDispatchStatus':
      return 'Checking dispatch';
    case 'getMetrics':
      return 'Reading metrics';
    case 'getRepoSkills':
      return 'Reading repo skills';
    case 'planFeature':
      return 'Checking the plan';
    default:
      return name;
  }
}

function truncateLines(text: string, max = RESULT_LINES): string {
  const lines = text.split('\n');
  return lines.length <= max ? text : `${lines.slice(0, max).join('\n')}\n… ${lines.length - max} more lines`;
}

const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '');

function Spinner({ label }: { label?: string }) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
    />
  );
}

function StatusIcon({ status, failed }: { status: ToolStatus; failed: boolean }) {
  if (failed) return <span role="img" aria-label="Failed" className="font-bold text-red-600">✕</span>;
  if (status === 'complete') return <span role="img" aria-label="Done" className="font-bold text-emerald-600">✓</span>;
  return <Spinner label="Running" />;
}

interface Job {
  id?: string;
  title?: string;
  status?: string;
}
const asJobs = (v: unknown): Job[] => {
  if (Array.isArray(v)) return v.filter((j): j is Job => !!j && typeof j === 'object');
  return v && typeof v === 'object' ? [v as Job] : [];
};

function JobList({ jobs }: { jobs: Job[] }) {
  if (jobs.length === 0) return <p className="text-muted-foreground">No jobs</p>;
  return (
    <ul className="space-y-0.5">
      {jobs.slice(0, 5).map((j, i) => (
        <li key={j.id ?? i} className="flex items-center gap-1.5">
          <span className="truncate">{j.title ?? j.id}</span>
          {j.status && <Badge variant={STATUS_VARIANT[j.status as JobStatus] ?? 'outline'}>{j.status}</Badge>}
        </li>
      ))}
      {jobs.length > 5 && <li className="text-muted-foreground">+{jobs.length - 5} more</li>}
    </ul>
  );
}

/** The compact, tool-specific line(s) shown under the label once a call is done; null falls back to the default. */
function summary(name: string, parameters: unknown, value: unknown): ReactNode {
  const a = asArgs(parameters);
  const r = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  switch (name) {
    case 'searchRepoCode': {
      const matches = Array.isArray(r.matches) ? (r.matches as { path?: string }[]) : null;
      if (!matches) return null;
      const paths = [...new Set(matches.map((m) => m.path).filter(Boolean))].slice(0, 3);
      return (
        <div>
          <p>
            <code>{String(a.query ?? '')}</code> · {matches.length}
            {r.truncated ? '+' : ''} {matches.length === 1 ? 'match' : 'matches'}
          </p>
          {paths.length > 0 && <p className="truncate text-muted-foreground">{paths.join(', ')}</p>}
        </div>
      );
    }
    case 'readRepoFile': {
      if (r.found === false) return <p className="text-muted-foreground">{String(r.path ?? a.path)} not found</p>;
      const range = r.startLine !== undefined ? ` · lines ${r.startLine}-${r.endLine}` : r.totalLines !== undefined ? ` · ${r.totalLines} lines` : '';
      return (
        <p>
          <code>{String(r.path ?? a.path ?? '')}</code>
          {range}
        </p>
      );
    }
    case 'listJobs':
    case 'getJob':
      return Array.isArray(value) || r.title !== undefined ? <JobList jobs={asJobs(value)} /> : null;
    case 'planFeature': {
      if (r.valid === true) return <Badge variant="success">valid</Badge>;
      if (Array.isArray(r.problems)) {
        return (
          <ul className="list-disc pl-4 text-red-700">
            {(r.problems as unknown[]).map((p, i) => (
              <li key={i}>{typeof p === 'string' ? p : JSON.stringify(p)}</li>
            ))}
          </ul>
        );
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * One tool call as a compact row: icon, label, state, and a collapsed details block with the arguments and the
 * (truncated) result. Finished calls of searchRepoCode, readRepoFile, getJob, listJobs and planFeature add a short summary.
 */
export function ToolCallView({ name, parameters, status, result }: ToolCallViewProps) {
  const [open, setOpen] = useState(false);
  const error = status === 'complete' ? toolError(result) : null;
  const value = status === 'complete' && !error ? parseResult(result) : undefined;
  const extra = value !== undefined ? summary(name, parameters, value) : null;
  const args = asArgs(parameters);
  const hasArgs = Object.keys(args).length > 0;

  return (
    <div data-testid="tool-call" data-tool={name} data-status={error ? 'error' : status} className="my-1 rounded-md border bg-background px-2 py-1 text-xs">
      <div className="flex items-center gap-1.5">
        <span aria-hidden className="shrink-0 text-muted-foreground">⚙</span>
        <span className="truncate font-medium">{toolLabel(name, parameters)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <StatusIcon status={status} failed={!!error} />
        </span>
      </div>
      {error && <p className="mt-0.5 text-red-700">{error}</p>}
      {extra && <div className="mt-0.5">{extra}</div>}
      {(hasArgs || result !== undefined) && (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="mt-0.5 text-muted-foreground underline-offset-2 hover:underline"
          >
            {open ? 'Hide details' : 'Show details'}
          </button>
          {open && (
            <div className="mt-1 space-y-1">
              {hasArgs && (
                <div>
                  <p className="text-muted-foreground">Arguments</p>
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-1">{pretty(args)}</pre>
                </div>
              )}
              {result !== undefined && (
                <div>
                  <p className="text-muted-foreground">Result</p>
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-1">{truncateLines(pretty(parseResult(result)))}</pre>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Consecutive tool calls of one reply. While the run is active the steps stay open; once it finishes they
 * fold into one collapsible "Worked through n steps".
 */
export function ToolCallGroup({ steps, active, children }: { steps: number; active: boolean; children: ReactNode }) {
  if (active) return <div data-testid="tool-call-group">{children}</div>;
  return (
    <details data-testid="tool-call-group" className="my-1 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        Worked through {steps} {steps === 1 ? 'step' : 'steps'}
      </summary>
      {children}
    </details>
  );
}

type ChatMessage = { id: string; role: string; content?: unknown; toolCalls?: unknown[]; generativeUI?: () => ReactNode };

/** An assistant message that only calls tools (no text), or the result of such a call. */
const isToolStep = (m: ChatMessage | undefined) =>
  !!m && (m.role === 'tool' || (m.role === 'assistant' && !!m.toolCalls?.length && !m.content));

/**
 * The sidebar's message renderer: like the default, but a run of consecutive tool steps is drawn once, by its
 * first message, as a ToolCallGroup; the other messages of the run render nothing.
 */
export const GroupedMessage: NonNullable<ComponentProps<typeof CopilotSidebar>['RenderMessage']> = (props) => {
  const { message, messages, index, inProgress, isCurrentMessage, AssistantMessage: Assistant = DefaultAssistantMessage, UserMessage: User = DefaultUserMessage } = props;
  const all = messages as ChatMessage[];
  const m = message as unknown as ChatMessage;

  if (isToolStep(m)) {
    if (isToolStep(all[index - 1])) return null;
    let end = index;
    while (isToolStep(all[end + 1])) end++;
    const run = all.slice(index, end + 1).filter((x) => x.role === 'assistant');
    const steps = run.reduce((n, x) => n + (x.toolCalls?.length ?? 0), 0);
    return (
      <ToolCallGroup steps={steps} active={inProgress && end === all.length - 1}>
        {run.map((x) => (
          <div key={x.id}>{x.generativeUI?.()}</div>
        ))}
      </ToolCallGroup>
    );
  }

  if (m.role === 'user') return <User rawData={message} data-message-role="user" message={message as never} ImageRenderer={props.ImageRenderer ?? DefaultImageRenderer} />;
  if (m.role !== 'assistant') return null;
  return (
    <Assistant
      data-message-role="assistant"
      subComponent={m.generativeUI?.() as never}
      rawData={message}
      message={message as never}
      messages={messages as never}
      isLoading={inProgress && isCurrentMessage && !m.content}
      isGenerating={inProgress && isCurrentMessage && !!m.content}
      isCurrentMessage={isCurrentMessage}
      onRegenerate={() => props.onRegenerate?.(m.id)}
      onCopy={props.onCopy}
      onThumbsUp={props.onThumbsUp}
      onThumbsDown={props.onThumbsDown}
      feedback={props.messageFeedback?.[m.id] || null}
      markdownTagRenderers={props.markdownTagRenderers}
      ImageRenderer={props.ImageRenderer ?? DefaultImageRenderer}
    />
  );
};

/** Shown while a run is in progress, also before the first tool call; `step` is the number of tool calls so far. */
export function BusyIndicator({ running, step }: { running: boolean; step?: number }) {
  if (!running) return null;
  return (
    <p
      role="status"
      className="fixed bottom-20 right-4 z-[1300] flex items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-xs shadow-sm"
    >
      <Spinner />
      Working…{step ? ` step ${step}` : ''}
    </p>
  );
}

/** Registers the wildcard renderer for backend tool calls. The approval tool keeps its own card (an interrupt). */
export function CopilotToolRenderers() {
  useRenderTool(
    {
      name: '*',
      group: true,
      render: (props: ToolCallViewProps) => (props.name === PLAN_TOOL ? null : <ToolCallView {...props} />),
    },
    [],
  );
  return null;
}

/** Busy indicator driven by the agent's run state; the step is the number of tool calls since the last user message. */
export function CopilotBusyIndicator() {
  const { agent } = useAgent({ agentId: 'gilde' });
  const messages = agent.messages as { role: string; toolCalls?: unknown[] }[];
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  const step = messages.slice(lastUser + 1).reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0);
  return <BusyIndicator running={agent.isRunning} step={step} />;
}
