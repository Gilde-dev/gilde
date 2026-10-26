import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@copilotkit/react-core/v2/headless', () => ({ useInterrupt: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { listRepos: vi.fn() } }));

import { api } from '@/lib/api';
import { useInterrupt } from '@copilotkit/react-core/v2/headless';
import { CopilotPlanApproval, PlanApprovalCard, planFromInterrupt, type FeaturePlan } from './copilot-plan-approval';

const plan: FeaturePlan = {
  projectId: 'p1',
  title: 'Dark mode',
  spec: 'Add a dark theme.',
  acceptanceCriteria: ['Toggle persists'],
  jobs: [
    { key: 'api', repoId: 'r1', title: 'Store preference', task: 'Line one\nLine two', acceptanceCriteria: ['PATCH works'], dependsOn: [] },
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

  it('shows the full task with line breaks, collapsed by default', () => {
    const { container } = render(<PlanApprovalCard plan={plan} onApprove={vi.fn()} onCancel={vi.fn()} />);
    const task = screen.getAllByText(/Line one/)[0];
    expect(task.textContent).toBe('Line one\nLine two');
    expect(task).toHaveClass('whitespace-pre-wrap');
    const details = container.querySelectorAll('details')[1];
    expect(details).not.toHaveAttribute('open');
    expect(details).toContainElement(task);
  });

  it('falls back to the repo id and dependency key when unknown', () => {
    render(<PlanApprovalCard plan={{ ...plan, jobs: [{ ...plan.jobs[1], dependsOn: ['missing'] }] }} onApprove={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/r2 · after missing/)).toBeInTheDocument();
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

describe('CopilotPlanApproval', () => {
  it('listens for interrupts of the gilde agent (there is no default agent)', () => {
    render(<CopilotPlanApproval />);
    expect(vi.mocked(useInterrupt).mock.calls.at(-1)?.[0]).toMatchObject({ agentId: 'gilde' });
  });

  it('resolves repo ids to full names from the plan project', async () => {
    vi.mocked(api.listRepos).mockResolvedValue([{ id: 'r1', fullName: 'gilde-dev/gilde' }] as never);
    render(<CopilotPlanApproval />);
    const { render: renderInterrupt } = vi.mocked(useInterrupt).mock.calls[0][0] as never as {
      render: (a: unknown) => JSX.Element;
    };
    const interrupt = { reason: 'mastra:tool_approval', metadata: { mastra: { toolName: 'createPlannedFeature', args: plan } } };
    render(renderInterrupt({ interrupt, resolve: vi.fn(), cancel: vi.fn() }));
    expect(screen.getAllByText(/r1/).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText(/gilde-dev\/gilde/)).toBeInTheDocument());
    expect(api.listRepos).toHaveBeenCalledWith('p1');
  });
});
