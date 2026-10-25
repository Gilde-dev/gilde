import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RepoDispatchReport } from '@/lib/api';
import { DispatchStrip } from './dispatch-strip';

const base: RepoDispatchReport = {
  repoId: 'r', fullName: 'gilde-dev/gilde', queued: 2, fired: 0, reason: 'none', detail: null, resetsAt: null,
  waitingOnDependencies: 0, waitingOnRevisions: 0,
};

describe('DispatchStrip', () => {
  it('renders nothing when no repo is held back', () => {
    const { container } = render(
      <DispatchStrip repos={[base, { ...base, reason: 'repo_paused', detail: 'x', queued: 0 }, { ...base, waitingOnDependencies: 2 }]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('explains the daily limit with the reset time', () => {
    render(<DispatchStrip repos={[{ ...base, reason: 'daily_limit', detail: '30/30', resetsAt: '2026-03-05T00:00:00.000Z' }]} />);
    expect(screen.getByText(/Daily limit reached 30\/30, resets at/)).toBeTruthy();
  });

  it('explains a paused repo and waiting jobs', () => {
    render(
      <DispatchStrip
        repos={[{ ...base, reason: 'repo_paused', detail: 'HTTP 401', waitingOnDependencies: 2, waitingOnRevisions: 1 }]}
      />,
    );
    const li = screen.getByRole('listitem');
    expect(li.textContent).toContain('Repo paused: HTTP 401');
    expect(li.textContent).toContain('2 jobs waiting on dependencies');
    expect(li.textContent).toContain('1 job waiting for a proposal decision');
  });
});
