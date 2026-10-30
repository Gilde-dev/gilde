import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, type Job } from '@/lib/api';
import { JobReviews, ReviewBanner, overridable, reviewOutcome } from './job-review';
import { blockingResult, page, passResult, review } from './job-review.fixture';

const job = { id: 'j1', status: 'pr_open', prNumber: 5 } as Job;
afterEach(() => vi.restoreAllMocks());

const renderTab = (first: ReturnType<typeof page>, opts: { job?: Job; canOverride?: boolean; onChanged?: () => void } = {}) =>
  render(<JobReviews job={opts.job ?? job} first={first} canOverride={opts.canOverride ?? true} onChanged={opts.onChanged ?? (() => undefined)} />);

describe('reviewOutcome', () => {
  it('only a complete pass is clean', () => {
    expect(reviewOutcome(review({ status: 'complete', result: passResult })).clean).toBe(true);
    for (const status of ['pending', 'running', 'incomplete', 'error', 'skipped'] as const) expect(reviewOutcome(review({ status })).clean).toBe(false);
    expect(reviewOutcome(review({ status: 'complete', result: blockingResult })).clean).toBe(false);
  });
});

describe('JobReviews', () => {
  it('shows a complete pass with SHA, base, coverage, suggestions, limits and links', () => {
    renderTab(page([review({ result: passResult, routing: { state: 'done', action: 'human', routedAt: 'x' } })], { revisionCount: 1 }));
    expect(screen.getByText('Complete: no blocking findings')).toBeInTheDocument();
    expect(screen.getByText('abcdef12')).toBeInTheDocument();
    expect(screen.getByText('11111111')).toBeInTheDocument();
    expect(screen.getByText('Covered by the new test')).toBeInTheDocument();
    expect(screen.getByText(/Assigned to other jobs/)).toBeInTheDocument();
    expect(screen.getByText('Rename')).toBeInTheDocument();
    expect(screen.getByText(/120s · 20 steps · 200,000 input tokens/)).toBeInTheDocument();
    expect(screen.getByText(/1 automatic revision so far/)).toBeInTheDocument();
    expect(screen.getByText('Sent to human review')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'GitHub review' })).toHaveAttribute('href', 'https://github.com/o/r/pull/5#pullrequestreview-9');
  });

  it('separates blocking findings from suggestions', () => {
    renderTab(page([review({ result: blockingResult })]));
    expect(screen.getByText('Complete: blocking findings')).toBeInTheDocument();
    expect(screen.getByText('Blocking findings (1)')).toBeInTheDocument();
    expect(screen.getByText('src/b.ts:9')).toBeInTheDocument();
    expect(screen.getByText('Guard x')).toBeInTheDocument();
    expect(screen.queryByText(/Suggestions, not blocking/)).not.toBeInTheDocument();
  });

  it.each([
    ['incomplete', 'too_large', 'too large', 'Incomplete: not a pass'],
    ['error', 'execution_error', 'model failed', 'Error: not a pass'],
    ['skipped', 'project_opt_out', 'Project opted out', 'Skipped: not reviewed'],
  ] as const)('shows %s reviews with their reason and never as a pass', (status, code, reason, label) => {
    const result = status === 'skipped' ? { kind: status, reasonCode: code, reason } : { kind: status, reasonCode: code, reason, partialFindings: [], suggestions: [] };
    renderTab(page([review({ status, verdict: null, result })]));
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.getByText(`[${code}]`)).toBeInTheDocument();
    expect(screen.queryByText(/no blocking findings/)).not.toBeInTheDocument();
  });

  it('labels partial findings as not routing', () => {
    const f = blockingResult.kind === 'complete' ? blockingResult.blockingFindings : [];
    renderTab(page([review({ status: 'incomplete', verdict: null, result: { kind: 'incomplete', reasonCode: 'timeout', reason: 'timed out', partialFindings: f, suggestions: [] } })]));
    expect(screen.getByText(/Partial findings \(the review did not finish/)).toBeInTheDocument();
    expect(screen.queryByText(/^Blocking findings/)).not.toBeInTheDocument();
  });

  it('shows pending and running without a verdict', () => {
    renderTab(page([review({ status: 'running', verdict: null }), review({ id: 'rv0', status: 'pending', verdict: null })]));
    expect(screen.getByText('Review running')).toBeInTheDocument();
    expect(screen.getByText('Review pending')).toBeInTheDocument();
  });

  it('renders hostile text and links as inert', () => {
    const evil = '<img src=x onerror=alert(1)> **bold** [x](javascript:alert(1))';
    const { container } = renderTab(page([review({
      links: { review: 'javascript:alert(1)', publicationId: null, pullRequest: null },
      result: { ...blockingResult, summary: evil, blockingFindings: [{ title: evil, evidence: evil, impact: evil, requestedFix: evil, path: '<script>', line: 1 }] } as never,
    })]));
    expect(container.querySelector('img, script')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(screen.queryByRole('link', { name: 'GitHub review' })).not.toBeInTheDocument();
    expect(screen.getAllByText(evil).length).toBeGreaterThan(0);
  });

  it('shows an audited override', () => {
    renderTab(page([review({ result: blockingResult, override: { suppressed: true, at: '2026-01-03T00:00:00.000Z', byUserId: 'u1', reason: 'Fine by me', overriddenResult: null } })]));
    expect(screen.getByText('Overridden by a person')).toBeInTheDocument();
    expect(screen.getByText('Fine by me')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Override automatic review' })).not.toBeInTheDocument();
  });

  it('shows an empty state', () => {
    renderTab(page([]));
    expect(screen.getByText(/No automatic review yet/)).toBeInTheDocument();
  });

  it('pages through older reviews', async () => {
    const spy = vi.spyOn(api, 'listJobReviews').mockResolvedValue(page([review({ id: 'old', headSha: 'oldoldold0000000', result: passResult })], { page: 2, total: 21 }));
    renderTab(page([review({ result: passResult })], { total: 21 }));
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('oldoldol')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith('j1', 2, 20);
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  });

  it('shows a page error', async () => {
    vi.spyOn(api, 'listJobReviews').mockRejectedValue(new Error('boom'));
    renderTab(page([review({ result: passResult })], { total: 21 }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});

describe('ReviewBanner', () => {
  it('says why a job was returned, with the findings', () => {
    render(<ReviewBanner revisionCount={1} latest={review({ result: blockingResult, routing: { state: 'done', action: 'revision', routedAt: 'x' } })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Returned to the agent by the automatic review (revision 1)');
    expect(screen.getByRole('alert')).toHaveTextContent('Null deref');
  });
  it('says why a job was parked', () => {
    render(<ReviewBanner revisionCount={2} latest={review({ result: blockingResult, routing: { state: 'done', action: 'park', routedAt: 'x' } })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Parked: automatic revisions exhausted after 2 revisions');
    expect(screen.getByRole('alert')).toHaveTextContent('Null deref');
  });
  it('shows a running review and nothing for a plain human hand-off', () => {
    const { rerender, container } = render(<ReviewBanner revisionCount={0} latest={review({ status: 'running' })} />);
    expect(screen.getByRole('status')).toHaveTextContent('running');
    rerender(<ReviewBanner revisionCount={0} latest={review({ result: passResult, routing: { state: 'done', action: 'human', routedAt: 'x' } })} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('override', () => {
  const latest = () => review({ result: blockingResult });

  it('is offered only for the decision the job waits on, to people', () => {
    expect(overridable(job, latest())).toBe(true);
    expect(overridable({ ...job, status: 'merged' }, latest())).toBe(false);
    expect(overridable({ ...job, status: 'awaiting_review' }, latest())).toBe(false);
    expect(overridable({ ...job, status: 'parked' }, review({ routing: { state: 'done', action: 'park', routedAt: 'x' } }))).toBe(true);
    expect(overridable({ ...job, status: 'queued' }, review({ routing: { state: 'done', action: 'revision', routedAt: 'x' } }))).toBe(true);
    expect(overridable(job, review({ status: 'running' }))).toBe(false);
    expect(overridable({ ...job, prNumber: 6 }, latest())).toBe(false);
    expect(overridable(job, undefined)).toBe(false);
    renderTab(page([latest()]), { canOverride: false });
    expect(screen.queryByRole('form', { name: 'Override automatic review' })).not.toBeInTheDocument();
  });

  it('explains its scope and requires a reason', () => {
    const spy = vi.spyOn(api, 'overrideJobReview');
    renderTab(page([latest()]));
    expect(screen.getByText(/only stops an automatic revision that has not started yet/)).toBeInTheDocument();
    expect(screen.getByText(/CI and protected-path approval still apply/)).toBeInTheDocument();
    expect(screen.getByText(/expires when a new head is pushed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Override and send/ }));
    expect(screen.getByText('A reason is required.')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends the current head, result and reason, then refreshes', async () => {
    const spy = vi.spyOn(api, 'overrideJobReview').mockResolvedValue(latest());
    const onChanged = vi.fn();
    renderTab(page([latest()]), { onChanged });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  Reviewed by hand  ' } });
    fireEvent.click(screen.getByRole('button', { name: /Override and send/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith('j1', { reviewId: 'rv1', headSha: 'abcdef1234567890', reason: 'Reviewed by hand' });
  });

  it.each([
    [403, 'Forbidden', /Only a signed-in person can override/],
    [409, 'The job has a different head than the one you reviewed', /different head.*refreshed/],
  ])('handles a %s without claiming success, and refreshes', async (status, detail, expected) => {
    vi.spyOn(api, 'overrideJobReview').mockRejectedValue(new ApiError(`POST failed: ${status} ${detail}`, status, detail));
    const onChanged = vi.fn();
    renderTab(page([latest()]), { onChanged });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'because' } });
    fireEvent.click(screen.getByRole('button', { name: /Override and send/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(expected);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.getByLabelText('Reason')).toHaveValue('because');
  });
});
