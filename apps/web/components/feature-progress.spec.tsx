import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JOB_STATUSES, type JobStatus } from '@/lib/api';
import { feature } from './feature.fixture';
import { FeatureProgressBar, progressCounts } from './feature-progress';

const progress = (counts: Partial<Record<JobStatus, number>>) => {
  const f = feature({}, counts.merged ?? 0, 8);
  f.progress.countByStatus = { ...Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])), ...counts } as Record<JobStatus, number>;
  return f.progress;
};

describe('FeatureProgressBar', () => {
  const p = progress({ merged: 3, pr_open: 2, queued: 1, parked: 1, rejected: 1 });

  it('groups statuses into segments', () => {
    expect(progressCounts(p).map((s) => s.count)).toEqual([3, 2, 1, 2]);
  });

  it('exposes counts as accessible text and tooltip', () => {
    render(<FeatureProgressBar progress={p} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuetext', '3 merged, 2 in progress, 1 waiting, 2 blocked or failed of 8 jobs');
    expect(bar).toHaveAttribute('title', bar.getAttribute('aria-valuetext'));
    expect(screen.getByText('3 merged, 2 in progress, 1 waiting, 2 blocked or failed of 8 jobs')).toHaveClass('sr-only');
  });

  it('draws only non-empty segments in token colours', () => {
    const { container } = render(<FeatureProgressBar progress={p} />);
    expect(container.querySelectorAll('[data-segment]')).toHaveLength(4);
    expect(container.querySelector('[data-segment="merged"]')).toHaveClass('bg-success');
    expect(container.querySelector('[data-segment="failed"]')).toHaveClass('bg-danger');
  });
});
