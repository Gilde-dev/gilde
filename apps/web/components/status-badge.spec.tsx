import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FEATURE_STATUSES, JOB_STATUSES } from '@/lib/api';
import { FEATURE_STATUS_BADGE, JOB_STATUS_BADGE, StatusBadge } from './status-badge';

describe('StatusBadge', () => {
  it('maps every job status to the specified label, colour and an icon', () => {
    const expected = {
      triage: ['Triage', 'neutral'],
      queued: ['Queued', 'info'],
      dispatched: ['Running', 'running'],
      pr_open: ['PR open', 'pr'],
      awaiting_review: ['Awaiting review', 'warning'],
      merged: ['Merged', 'success'],
      rejected: ['Rejected', 'danger'],
      parked: ['Parked', 'danger'],
      cancelled: ['Cancelled', 'neutral'],
    } as const;
    expect(Object.keys(JOB_STATUS_BADGE).sort()).toEqual([...JOB_STATUSES].sort());
    for (const s of JOB_STATUSES) {
      expect([JOB_STATUS_BADGE[s].label, JOB_STATUS_BADGE[s].variant]).toEqual(expected[s]);
      expect(JOB_STATUS_BADGE[s].icon).toBeTruthy();
    }
  });

  it('maps every feature status to the specified label, colour and an icon', () => {
    const expected = { draft: ['Draft', 'neutral'], active: ['Active', 'running'], done: ['Done', 'success'], cancelled: ['Cancelled', 'neutral'] } as const;
    expect(Object.keys(FEATURE_STATUS_BADGE).sort()).toEqual([...FEATURE_STATUSES].sort());
    for (const s of FEATURE_STATUSES) {
      expect([FEATURE_STATUS_BADGE[s].label, FEATURE_STATUS_BADGE[s].variant]).toEqual(expected[s]);
      expect(FEATURE_STATUS_BADGE[s].icon).toBeTruthy();
    }
  });

  it('renders the human label with a decorative icon', () => {
    const { container } = render(<StatusBadge status="awaiting_review" />);
    expect(screen.getByText('Awaiting review')).toHaveClass('bg-warning-soft');
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders feature statuses', () => {
    render(<StatusBadge status="active" kind="feature" />);
    expect(screen.getByText('Active')).toHaveClass('bg-running-soft');
  });

  it('falls back for an unknown status', () => {
    render(<StatusBadge status="weird_state" />);
    expect(screen.getByText('weird state')).toBeInTheDocument();
  });
});
