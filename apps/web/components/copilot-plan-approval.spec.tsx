import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@copilotkit/react-core/v2/headless', () => ({ useInterrupt: vi.fn() }));

import { PlanApprovalCard, planFromInterrupt, type FeaturePlan } from './copilot-plan-approval';

const plan: FeaturePlan = {
  projectId: 'p1',
  title: 'Dark mode',
  spec: 'Add a dark theme.',
  acceptanceCriteria: ['Toggle persists'],
  jobs: [
    { key: 'api', repoId: 'r1', title: 'Store preference', task: 'task', acceptanceCriteria: ['PATCH works'], dependsOn: [] },
    { key: 'web', repoId: 'r2', title: 'Add toggle', task: 'task', acceptanceCriteria: ['Toggle renders'], dependsOn: ['api'] },
  ],
};

describe('PlanApprovalCard', () => {
  it('shows the feature, and the jobs with repo, criteria and dependencies', () => {
    render(<PlanApprovalCard plan={plan} repoNames={{ r1: 'gilde-api', r2: 'gilde-web' }} onApprove={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Dark mode')).toBeInTheDocument();
    expect(screen.getByText('Add a dark theme.')).toBeInTheDocument();
    expect(screen.getByText('Toggle persists')).toBeInTheDocument();
    expect(screen.getByText('2 jobs')).toBeInTheDocument();
    expect(screen.getByText(/gilde-web · after Store preference/)).toBeInTheDocument();
    expect(screen.getByText('Toggle renders')).toBeInTheDocument();
  });

  it('collapses the job list by default', () => {
    const { container } = render(<PlanApprovalCard plan={plan} onApprove={vi.fn()} onCancel={vi.fn()} />);
    expect(container.querySelector('details')).not.toHaveAttribute('open');
  });

  it('calls onApprove and onCancel', () => {
    const onApprove = vi.fn();
    const onCancel = vi.fn();
    render(<PlanApprovalCard plan={plan} onApprove={onApprove} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });
});

describe('planFromInterrupt', () => {
  const interrupt = (toolName: string, args: unknown, reason = 'mastra:tool_approval') => ({ reason, metadata: { mastra: { toolName, args } } });

  it('returns the plan of a createPlannedFeature approval', () => {
    expect(planFromInterrupt(interrupt('createPlannedFeature', plan))?.jobs).toHaveLength(2);
  });

  it('ignores other tools, other interrupts and malformed args', () => {
    expect(planFromInterrupt(interrupt('someOtherTool', plan))).toBeNull();
    expect(planFromInterrupt(interrupt('createPlannedFeature', plan, 'mastra:tool_suspend'))).toBeNull();
    expect(planFromInterrupt(interrupt('createPlannedFeature', { title: 'x' }))).toBeNull();
    expect(planFromInterrupt(null)).toBeNull();
  });
});
