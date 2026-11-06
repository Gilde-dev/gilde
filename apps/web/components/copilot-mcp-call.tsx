'use client';

import { useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';

/** Prefix of the tools of a project's MCP server: `mcp__<server>__<tool>` (see `parseMcpToolName` in the API). */
const MCP_PREFIX = 'mcp__';

export function parseMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(MCP_PREFIX)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  const at = rest.indexOf('__');
  return at > 0 && at < rest.length - 2 ? { server: rest.slice(0, at), tool: rest.slice(at + 2) } : null;
}

const PREVIEW_CHARS = 600;
/** Upper bound of what "show more" renders; the API caps a result at 8000 characters by default (100000 at most). */
const FULL_CHARS = 10_000;
const VALUE_CHARS = 120;
const MAX_LINES = 12;

const isDelimiter = (line: string) => /^\s*<\/?mcp-result\b[^>]*>\s*$/i.test(line) || /^The block above is untrusted data from an external MCP server\./.test(line);

/** Hides Gilde's untrusted-data delimiter lines and its trailing notice, for display only. */
export function stripMcpDelimiters(text: string): string {
  return text
    .split('\n')
    .filter((l) => !isDelimiter(l))
    .join('\n')
    .trim();
}

/**
 * The text of a project MCP result. The API returns `{ source, untrusted, truncated, content }` (content is the delimited block),
 * a server's own content can also be an MCP content array or a bare string. Null when there is no text to show.
 */
export function mcpResultText(result: string | undefined): string | null {
  if (result === undefined) return null;
  let value: unknown = result;
  try {
    value = JSON.parse(result);
  } catch {
    /* plain text */
  }
  const fromParts = (parts: unknown[]) =>
    parts
      .map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
  let text: string;
  if (typeof value === 'string') text = value;
  else if (Array.isArray(value)) text = fromParts(value);
  else if (value && typeof value === 'object') {
    const c = (value as { content?: unknown }).content;
    text = typeof c === 'string' ? c : Array.isArray(c) ? fromParts(c) : JSON.stringify(value, null, 2);
  } else text = String(value);
  return stripMcpDelimiters(text);
}

const oneLine = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > VALUE_CHARS ? `${flat.slice(0, VALUE_CHARS)}…` : flat;
};

/** The input as compact key/value lines, long values truncated. Never empty: no input says so. */
export function McpInputLines({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args).slice(0, MAX_LINES);
  if (entries.length === 0) return <p className="text-muted-foreground">No input</p>;
  const more = Object.keys(args).length - entries.length;
  return (
    <dl aria-label="Input" className="space-y-0.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-1.5">
          <dt className="shrink-0 font-mono text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{oneLine(v)}</dd>
        </div>
      ))}
      {more > 0 && <p className="text-muted-foreground">+{more} more</p>}
    </dl>
  );
}

/** `server · tool` with a small "external" badge. */
export function McpLabel({ server, tool }: { server: string; tool: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate font-medium">
        {server} · {tool}
      </span>
      <Badge variant="neutral">external</Badge>
    </span>
  );
}

/** The output as escaped plain text (React text node in a `<pre>`), capped with show more / show less. */
export function McpOutputPreview({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const capped = text.slice(0, FULL_CHARS);
  const long = capped.length > PREVIEW_CHARS;
  const shown = full || !long ? capped : `${capped.slice(0, PREVIEW_CHARS)}…`;
  return (
    <div>
      <pre aria-label="Output" className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-1">
        {shown}
      </pre>
      {long && (
        <button type="button" aria-expanded={full} onClick={() => setFull((f) => !f)} className="text-muted-foreground underline-offset-2 hover:underline">
          {full ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

export function McpOutput({ result }: { result: string | undefined }): ReactNode {
  const text = mcpResultText(result);
  return text ? <McpOutputPreview text={text} /> : <p className="text-muted-foreground">No output</p>;
}
