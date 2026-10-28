import type { ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { safeUrl } from '@/lib/safe-url';
import { cn } from '@/lib/utils';

/** Text that is not a link when its URL is unsafe: keeps the label, drops the target. */
function SafeLink({ href, children }: ComponentProps<'a'>) {
  const target = safeUrl(href);
  if (!target) return <span className="underline decoration-dotted">{children}</span>;
  const external = /^[a-z][a-z0-9+.-]*:/i.test(target);
  return (
    <a href={target} className="text-primary underline" {...(external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})}>
      {children}
    </a>
  );
}

const components: Components = {
  a: SafeLink,
  h1: ({ children }) => <h3 className="mt-4 text-lg font-semibold">{children}</h3>,
  h2: ({ children }) => <h4 className="mt-4 text-md font-semibold">{children}</h4>,
  h3: ({ children }) => <h5 className="mt-3 text-md font-semibold">{children}</h5>,
  h4: ({ children }) => <h6 className="mt-3 text-md font-semibold">{children}</h6>,
  h5: ({ children }) => <h6 className="mt-3 text-md font-semibold">{children}</h6>,
  h6: ({ children }) => <h6 className="mt-3 text-md font-semibold">{children}</h6>,
  p: ({ children }) => <p className="my-2 text-md">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
  pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-sm">{children}</pre>,
  code: ({ children, className }) => <code className={cn('rounded bg-muted px-1 font-mono text-sm', className)}>{children}</code>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
};

/**
 * Markdown from other people (spec bodies, task text) as safe React elements. Raw HTML is never interpreted: react-markdown
 * has no HTML plugin here, so `<script>` or `<img onerror=…>` shows up as visible text. Images are not loaded (their alt
 * text stays), and a link is only a link for http, https, mailto and relative targets.
 */
export function SafeMarkdown({ source, className }: { source: string; className?: string }) {
  return (
    <div className={cn('break-words', className)}>
      <ReactMarkdown
        components={components}
        disallowedElements={['img', 'iframe', 'script', 'style', 'object', 'embed']}
        unwrapDisallowed
        urlTransform={(url) => safeUrl(url) ?? ''}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
