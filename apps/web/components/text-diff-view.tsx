import { DIFF_MAX_LINES, diffLines, diffStats } from '@/lib/text-diff';
import { cn } from '@/lib/utils';

const MARK = { same: ' ', add: '+', del: '-' } as const;
const TONE = { same: '', add: 'bg-success-soft text-success', del: 'bg-danger-soft text-danger' } as const;

/**
 * A line diff as plain text. Every line is a React text node, so nothing in it is ever interpreted as markup; added and
 * removed lines carry a +/- sign as well as colour.
 */
export function TextDiffView({ before, after, label = 'Changes' }: { before: string; after: string; label?: string }) {
  const lines = diffLines(before, after);
  if (!lines) {
    return <p className="text-sm text-muted-foreground">Too large to compare here (over {DIFF_MAX_LINES} lines). Read the versions one by one.</p>;
  }
  const { added, removed } = diffStats(lines);
  if (added === 0 && removed === 0) return <p className="text-sm text-muted-foreground">No changes in the text.</p>;
  return (
    <figure aria-label={label} className="overflow-x-auto rounded-md border border-border font-mono text-sm">
      <figcaption className="border-b border-border px-3 py-1 text-label text-muted-foreground">
        {added} added, {removed} removed
      </figcaption>
      <pre className="m-0 p-0">
        {lines.map((l, i) => (
          <div key={i} data-diff={l.kind} className={cn('whitespace-pre-wrap break-words px-3', TONE[l.kind])}>
            <span aria-hidden className="select-none pr-2">{MARK[l.kind]}</span>
            <span className="sr-only">{l.kind === 'add' ? 'Added: ' : l.kind === 'del' ? 'Removed: ' : ''}</span>
            {l.text}
          </div>
        ))}
      </pre>
    </figure>
  );
}
