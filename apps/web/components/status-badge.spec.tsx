import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FEATURE_STATUSES, JOB_STATUSES } from '@/lib/api';
import { FEATURE_STATUS_BADGE, JOB_STATUS_BADGE, StatusBadge } from './status-badge';

describe('StatusBadge', () => {
  it('has a label and variant for every job status', () => {
    for (const s of JOB_STATUSES) {
      expect(JOB_STATUS_BADGE[s].label).toBeTruthy();
      expect(JOB_STATUS_BADGE[s].variant).toBeTruthy();
    }
  });

  it('has a label and variant for every feature status', () => {
    for (const s of FEATURE_STATUSES) {
      expect(FEATURE_STATUS_BADGE[s].label).toBeTruthy();
      expect(FEATURE_STATUS_BADGE[s].variant).toBeTruthy();
    }
  });

  it('renders the human label', () => {
    render(<StatusBadge status="awaiting_review" />);
    expect(screen.getByText('Awaiting review')).toBeInTheDocument();
  });

  it('falls back for an unknown status', () => {
    render(<StatusBadge status="weird_state" />);
    expect(screen.getByText('weird state')).toBeInTheDocument();
  });
});
