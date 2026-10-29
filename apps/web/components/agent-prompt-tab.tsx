'use client';

import { useCallback } from 'react';
import { api, type AgentPrompt, type PromptText } from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { usePolling } from '@/lib/use-polling';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';

const POLL_MS = 60_000;

/** Prompt text is shown as plain text in a scrollable block; it is never rendered as markup. */
function PromptBlock({ prompt, label }: { prompt: PromptText; label: string }) {
  return (
    <section aria-label={label} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-md font-semibold">{label}</h3>
        <Badge variant="neutral">
          Version <span className="font-mono">{prompt.version}</span>
        </Badge>
        <span className="text-sm text-muted-foreground">{prompt.length.toLocaleString('en')} characters</span>
      </div>
      <pre
        tabIndex={0}
        aria-label={`${label} text`}
        className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted p-3 font-mono text-sm"
      >
        {prompt.text}
      </pre>
    </section>
  );
}

function List({ title, items, ordered }: { title: string; items: string[]; ordered?: boolean }) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <section aria-label={title} className="space-y-1">
      <h4 className="text-sm font-medium">{title}</h4>
      <Tag className={`space-y-1 pl-5 text-sm ${ordered ? 'list-decimal' : 'list-disc'}`}>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </Tag>
    </section>
  );
}

function CodingAssembly({ coding }: { coding: NonNullable<AgentPrompt['coding']> }) {
  return (
    <section aria-label="Job payload" className="space-y-4">
      <h3 className="text-md font-semibold">How a job prompt is assembled</h3>
      {coding.instructionsPath === null && (
        <p role="note" className="text-sm text-muted-foreground">
          AGENT_INSTRUCTIONS_PATH is not set, so jobs are sent without agent instructions.
        </p>
      )}
      {coding.loadError && (
        <p role="alert" className="text-sm text-danger">
          {coding.loadError}
        </p>
      )}
      {coding.instructionsPath && (
        <p className="text-sm text-muted-foreground">
          Loaded from <span className="font-mono">{coding.instructionsPath}</span> (AGENT_INSTRUCTIONS_PATH); edits apply without a restart.
        </p>
      )}
      <List title="Sections, in order" items={coding.layout} ordered />
      <section aria-label="Payload keys" className="space-y-1">
        <h4 className="text-sm font-medium">Payload keys</h4>
        <p className="flex flex-wrap gap-1">
          {coding.payloadKeys.map((k) => (
            <Badge key={k} variant="neutral">
              <span className="font-mono">{k}</span>
            </Badge>
          ))}
        </p>
      </section>
      <List title="Limits" items={coding.limits} />
      <List title="Trimming order, while over the limit" items={coding.trimmingOrder} ordered />
    </section>
  );
}

function PromptContent({ prompt }: { prompt: AgentPrompt }) {
  return (
    <div className="space-y-6">
      <p role="note" className="max-w-prose text-sm text-muted-foreground">
        Read-only. Prompts are code, not settings: they change by changing the source file and deploying. This is the text as the agent receives it,
        rendered by the same functions the agent uses.
      </p>
      {prompt.note && <p className="max-w-prose text-sm text-muted-foreground">{prompt.note}</p>}
      {prompt.kind === 'none' && <p className="text-sm text-muted-foreground">This agent has no prompt of its own.</p>}
      {prompt.exampleBinding && (
        <p role="note" className="rounded-lg border border-info/40 bg-info-soft p-3 text-sm text-info">
          {prompt.exampleBinding}
        </p>
      )}
      {prompt.file && (
        <p className="text-sm">
          Source:{' '}
          {prompt.file.url ? (
            <a href={prompt.file.url} target="_blank" rel="noopener noreferrer" className="font-mono underline">
              {prompt.file.path}
            </a>
          ) : (
            <span className="font-mono">{prompt.file.path}</span>
          )}{' '}
          <span className="text-muted-foreground">
            at {prompt.file.refKind === 'commit' ? 'commit' : 'branch'} <span className="font-mono">{prompt.file.ref.slice(0, 12)}</span>, {prompt.file.refSource}
          </span>
        </p>
      )}
      {prompt.instructions && <PromptBlock prompt={prompt.instructions} label={prompt.coding ? 'Agent instructions' : 'Instructions'} />}
      {prompt.runPrompt && <PromptBlock prompt={prompt.runPrompt} label="Run prompt (example)" />}
      {Object.keys(prompt.settings).length > 0 && (
        <section aria-label="Current settings" className="space-y-1">
          <h3 className="text-md font-semibold">Current settings</h3>
          <p className="text-sm text-muted-foreground">
            {Object.entries(prompt.settings).map(([k, v], i) => (
              <span key={k}>
                {i > 0 && ' · '}
                <span className="font-mono">{k}</span> {v}
              </span>
            ))}
          </p>
        </section>
      )}
      {prompt.coding && <CodingAssembly coding={prompt.coding} />}
    </div>
  );
}

export function PromptTab({ agent }: { agent: string }) {
  const load = useCallback(() => api.getAgentPrompt(agent), [agent]);
  const { data, error, loading, refresh } = usePolling(load, POLL_MS);
  if (loading && !data) {
    return (
      <div role="status" aria-label="Loading prompt" className="space-y-2">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (error && !data) {
    return (
      <div role="alert" className="flex items-center gap-3 text-sm text-danger">
        <span>{errorText(error)}</span>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  }
  return data ? <PromptContent prompt={data} /> : null;
}
