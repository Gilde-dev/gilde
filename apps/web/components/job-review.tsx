'use client';

import { useCallback, useState } from 'react';
import { api, type Job, type PrReview, type PrReviewPage, type ReviewBlockingFinding, type ReviewSuggestion } from '@/lib/api';
import { errorText, humanOnlyErrorText } from '@/lib/job-actions';
import { safeUrl } from '@/lib/safe-url';
import { relativeTime } from '@/lib/time';
import { usePolling } from '@/lib/use-polling';
import { Badge, type BadgeVariant } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Field } from './ui/field';
import { Textarea } from './ui/textarea';

const POLL_MS = 15_000;
export const REVIEW_PAGE_SIZE = 20;

const shortSha = (sha: string | null) => (sha ? sha.slice(0, 8) : 'none');

/** Reviews are model output about untrusted code: everything is rendered as plain text, links only when their URL is safe. */
function Text({ children, className }: { children: string; className?: string }) {
  return <p className={`whitespace-pre-wrap break-words ${className ?? ''}`}>{children}</p>;
}

function Place({ path, line }: { path?: string; line?: number }) {
  if (!path) return null;
  return <code className="font-mono text-sm">{path}{line ? `:${line}` : ''}</code>;
}

function ExternalLink({ href, children }: { href: string | null; children: string }) {
  const target = safeUrl(href);
  if (!target) return null;
  return (
    <a href={target} target="_blank" rel="noopener noreferrer nofollow" className="underline">
      {children}
    </a>
  );
}

interface Outcome {
  label: string;
  variant: BadgeVariant;
  /** True only for a complete review that found nothing blocking. */
  clean: boolean;
}

/** What a review amounts to. Incomplete, skipped and failed reviews are never shown like a pass. */
export function reviewOutcome(r: PrReview): Outcome {
  switch (r.status) {
    case 'pending':
      return { label: 'Review pending', variant: 'info', clean: false };
    case 'running':
      return { label: 'Review running', variant: 'running', clean: false };
    case 'complete':
      return r.result?.kind === 'complete' && r.result.verdict === 'pass'
        ? { label: 'Complete: no blocking findings', variant: 'success', clean: true }
        : { label: 'Complete: blocking findings', variant: 'danger', clean: false };
    case 'incomplete':
      return { label: 'Incomplete: not a pass', variant: 'warning', clean: false };
    case 'error':
      return { label: 'Error: not a pass', variant: 'danger', clean: false };
    case 'skipped':
      return { label: 'Skipped: not reviewed', variant: 'neutral', clean: false };
  }
}

function routingText(r: PrReview): string | null {
  if (r.override.suppressed) return 'Overridden by a person';
  if (r.routing.state !== 'done') return r.status === 'pending' || r.status === 'running' ? null : 'Routing…';
  if (r.routing.action === 'revision') return 'Returned to the agent for a revision';
  if (r.routing.action === 'park') return 'Parked: automatic revisions exhausted';
  if (r.routing.action === 'human') return 'Sent to human review';
  return null;
}

function Findings({ title, findings, tone }: { title: string; findings: ReviewBlockingFinding[]; tone: 'blocking' | 'partial' }) {
  if (findings.length === 0) return null;
  return (
    <div>
      <h4 className={`text-sm font-semibold ${tone === 'blocking' ? 'text-danger' : 'text-warning'}`}>{title} ({findings.length})</h4>
      <ul className="mt-1 space-y-2">
        {findings.map((f, i) => (
          <li key={i} className="space-y-1 rounded-md border border-border p-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{f.title}</span>
              <Place path={f.path} line={f.line} />
              {f.criterionId && <Badge variant="neutral">{f.criterionId}</Badge>}
            </div>
            <div><span className="font-medium">Evidence: </span><Text className="inline">{f.evidence}</Text></div>
            <div><span className="font-medium">Impact: </span><Text className="inline">{f.impact}</Text></div>
            <div><span className="font-medium">Requested fix: </span><Text className="inline">{f.requestedFix}</Text></div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Suggestions({ suggestions }: { suggestions: ReviewSuggestion[] }) {
  if (suggestions.length === 0) return null;
  return (
    <div>
      <h4 className="text-sm font-semibold">Suggestions, not blocking ({suggestions.length})</h4>
      <ul className="mt-1 space-y-2">
        {suggestions.map((s, i) => (
          <li key={i} className="space-y-1 rounded-md border border-border p-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{s.title}</span>
              <Place path={s.path} line={s.line} />
            </div>
            <Text>{s.detail}</Text>
          </li>
        ))}
      </ul>
    </div>
  );
}

const CRITERION_VARIANT = { met: 'success', unmet: 'danger', unverifiable: 'warning', not_applicable: 'neutral' } as const;

function Coverage({ review }: { review: PrReview }) {
  if (review.result?.kind !== 'complete') return null;
  const relevant = review.result.coverage.filter((c) => c.relevance === 'relevant');
  const elsewhere = review.result.coverage.filter((c) => c.relevance === 'assigned_elsewhere');
  const row = (c: (typeof relevant)[number]) => (
    <li key={c.criterionId} className="space-y-0.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{c.criterionId}</span>
        <Badge variant={CRITERION_VARIANT[c.status]}>{c.status.replace(/_/g, ' ')}</Badge>
      </div>
      <Text className="text-muted-foreground">{c.explanation}</Text>
    </li>
  );
  return (
    <div>
      <h4 className="text-sm font-semibold">Criteria for this job ({relevant.length})</h4>
      {relevant.length === 0 ? <p className="text-sm text-muted-foreground">None assessed</p> : <ul className="mt-1 space-y-2">{relevant.map(row)}</ul>}
      {elsewhere.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-muted-foreground">Assigned to other jobs ({elsewhere.length}); never a reason to send this job back</summary>
          <ul className="mt-1 space-y-2">{elsewhere.map(row)}</ul>
        </details>
      )}
    </div>
  );
}

function Limits({ review }: { review: PrReview }) {
  const l = review.limits;
  if (!l) return null;
  return (
    <p className="text-sm text-muted-foreground">
      Limits: {Math.round(l.timeoutMs / 1000)}s · {l.maxSteps} steps · {l.maxInputTokens.toLocaleString('en')} input tokens ·{' '}
      {l.maxOutputTokens.toLocaleString('en')} output tokens · {l.maxRevisions} automatic revisions per job
      {review.inputTokens !== null && ` · used ${review.inputTokens.toLocaleString('en')} in / ${(review.outputTokens ?? 0).toLocaleString('en')} out`}
    </p>
  );
}

function ReviewCard({ review }: { review: PrReview }) {
  const outcome = reviewOutcome(review);
  const result = review.result;
  const routing = routingText(review);
  const reason = result && result.kind !== 'complete' ? result.reason : review.reason;
  const reasonCode = result && result.kind !== 'complete' ? result.reasonCode : review.reasonCode;
  const blocking = result?.kind === 'complete' ? result.blockingFindings : [];
  const partial = result && (result.kind === 'incomplete' || result.kind === 'error') ? result.partialFindings : [];
  const suggestions = result && result.kind !== 'skipped' ? result.suggestions : [];
  return (
    <Card>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={outcome.variant} dot>{outcome.label}</Badge>
          <span className="text-muted-foreground">
            head <span className="font-mono">{shortSha(review.headSha)}</span>
            {review.baseSha && <> on base <span className="font-mono">{shortSha(review.baseSha)}</span>{review.baseRef && <> ({review.baseRef})</>}</>}
            {' · '}
            <time dateTime={review.createdAt} title={new Date(review.createdAt).toLocaleString('en')}>{relativeTime(review.createdAt)}</time>
            {review.model && <> · {review.model}</>}
          </span>
          <span className="ml-auto flex gap-3">
            <ExternalLink href={review.links.review}>GitHub review</ExternalLink>
            <ExternalLink href={review.links.pullRequest}>PR</ExternalLink>
          </span>
        </div>
        {routing && <p className="font-medium">{routing}</p>}
        {reason && (
          <p role="note" className={`rounded-md p-2 ${review.status === 'skipped' ? 'bg-muted' : 'bg-warning-soft'}`}>
            <span className="font-medium">{review.status === 'skipped' ? 'Skipped' : review.status === 'error' ? 'Failed' : 'Incomplete'}</span>
            {reasonCode && <span className="font-mono text-sm"> [{reasonCode}]</span>}: <span className="whitespace-pre-wrap break-words">{reason}</span>
          </p>
        )}
        {result?.kind === 'complete' && <Text>{result.summary}</Text>}
        <Findings title="Blocking findings" findings={blocking} tone="blocking" />
        <Findings title="Partial findings (the review did not finish; they did not route)" findings={partial} tone="partial" />
        <Suggestions suggestions={suggestions} />
        <Coverage review={review} />
        <Limits review={review} />
        {review.override.suppressed && (
          <div className="rounded-md border border-border p-2">
            <p className="font-medium">Overridden{review.override.at && <> <time dateTime={review.override.at}>{relativeTime(review.override.at)}</time></>}</p>
            {review.override.reason && <Text>{review.override.reason}</Text>}
            <p className="text-muted-foreground">
              {review.override.byUserId ? <>By user <span className="font-mono">{review.override.byUserId}</span>. </> : null}
              The original decision above is kept for the audit.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Whether the newest review is the decision a job is currently waiting on, so a person can still override it. */
export function overridable(job: Pick<Job, 'status' | 'prNumber'>, latest: PrReview | undefined): boolean {
  if (!latest || latest.override.suppressed || latest.prNumber !== job.prNumber) return false;
  if (latest.status === 'pending' || latest.status === 'running') return false;
  if (job.status === 'pr_open') return latest.routing.state === 'unclaimed';
  if (job.status === 'parked') return latest.routing.state === 'done' && latest.routing.action === 'park';
  if (job.status === 'queued') return latest.routing.state === 'done' && latest.routing.action === 'revision';
  return false;
}

export function ReviewOverrideForm({ jobId, review, onChanged }: { jobId: string; review: PrReview; onChanged: () => void | Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = reason.trim().length === 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (missing) {
      setError('A reason is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.overrideJobReview(jobId, { reviewId: review.id, headSha: review.headSha, reason: reason.trim() });
      setReason('');
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      setError(
        status === 409 ? `${errorText(err)}. The page is refreshed; check the current state before trying again.` : humanOnlyErrorText(err, 'override an automatic review'),
      );
    } finally {
      setBusy(false);
      // The API is authoritative: success and failure alike are shown from a fresh read, never assumed.
      try {
        await onChanged();
      } catch {
        // the next poll retries
      }
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-2 rounded-md border border-border p-3 text-sm" aria-label="Override automatic review">
      <h4 className="font-semibold">Override the automatic review</h4>
      <p className="text-muted-foreground">
        Sends this job to human review for head <span className="font-mono">{shortSha(review.headSha)}</span>. It only stops an automatic revision that
        has not started yet; work that is already running is not cancelled. CI and protected-path approval still apply. The override expires when a new
        head is pushed.
      </p>
      <Field label="Reason" message={error === 'A reason is required.' ? error : undefined}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
      </Field>
      {error && error !== 'A reason is required.' && (
        <p role="alert" className="text-danger">{error}</p>
      )}
      <Button type="submit" size="sm" variant="outline" disabled={busy}>
        {busy ? 'Overriding…' : 'Override and send to human review'}
      </Button>
    </form>
  );
}

/** The newest review's outcome as a short banner: why a job was returned or parked, or that a review is in flight. */
export function ReviewBanner({ latest, revisionCount }: { latest: PrReview | undefined; revisionCount: number }) {
  if (!latest || latest.override.suppressed) return null;
  const r = latest.result;
  if (latest.status === 'pending' || latest.status === 'running') {
    return <p role="status" className="rounded-md bg-info-soft p-2 text-sm text-info">Automatic review {latest.status} for head {shortSha(latest.headSha)}.</p>;
  }
  const returned = latest.routing.state === 'done' && latest.routing.action === 'revision';
  const parked = latest.routing.state === 'done' && latest.routing.action === 'park';
  if (!returned && !parked) return null;
  const findings = r?.kind === 'complete' ? r.blockingFindings : [];
  return (
    <div role="alert" className="space-y-1 rounded-md bg-danger-soft p-3 text-sm text-danger">
      <p className="font-semibold">
        {returned
          ? `Returned to the agent by the automatic review (revision ${revisionCount})`
          : `Parked: automatic revisions exhausted after ${revisionCount} revision${revisionCount === 1 ? '' : 's'}`}
      </p>
      {findings.length > 0 ? (
        <ul className="list-disc pl-5">
          {findings.map((f, i) => (
            <li key={i}>
              <span className="whitespace-pre-wrap break-words">{f.title}</span>
              {f.path && <> (<span className="font-mono">{f.path}{f.line ? `:${f.line}` : ''}</span>)</>}
            </li>
          ))}
        </ul>
      ) : (
        <p>No blocking findings were recorded for this decision.</p>
      )}
    </div>
  );
}

/** The Reviews tab: paginated history of automatic reviews, with the override form for the newest decision. */
export function JobReviews({ job, first, onChanged, canOverride }: { job: Job; first: PrReviewPage | undefined; onChanged: () => void | Promise<void>; canOverride: boolean }) {
  const [page, setPage] = useState(1);
  const fetchPage = useCallback(() => api.listJobReviews(job.id, page, REVIEW_PAGE_SIZE), [job.id, page]);
  const paged = usePolling(fetchPage, POLL_MS);
  const data = page === 1 ? (first ?? paged.data) : paged.data;
  const error = page === 1 && first ? null : paged.error;

  if (!data) {
    return error ? <p role="alert" className="text-sm text-danger">{error.message}</p> : <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const latest = first?.items[0];
  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-sm text-danger">{error.message}</p>}
      <p className="text-sm text-muted-foreground">
        {data.total} automatic review{data.total === 1 ? '' : 's'} · {data.revisionCount} automatic revision{data.revisionCount === 1 ? '' : 's'} so far
      </p>
      {canOverride && overridable(job, latest) && latest && <ReviewOverrideForm jobId={job.id} review={latest} onChanged={onChanged} />}
      {data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No automatic review yet. Reviews run after green CI when the project has automatic review enabled.</p>
      ) : (
        data.items.map((r) => <ReviewCard key={r.id} review={r} />)
      )}
      {pages > 1 && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
          <span className="text-sm text-muted-foreground">Page {page} of {pages}</span>
          <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}
