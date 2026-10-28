import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@copilotkit/react-core/v2/headless', () => ({ useInterrupt: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { listRepos: vi.fn(), getRepo: vi.fn(), getFeature: vi.fn(), getJob: vi.fn(), getSpec: vi.fn() } }));

import { api, type SpecDetail } from '@/lib/api';
import { useInterrupt } from '@copilotkit/react-core/v2/headless';
import {
  CopilotPlanApproval,
  PlanApprovalCard,
  SpecDraftCard,
  planFromInterrupt,
  planPin,
  specDraftFromInterrupt,
  specPreview,
  type FeaturePlan,
  type SpecDraft,
} from './copilot-plan-approval';

const version = (n: number, body: string, approvalId: string | null = null) => ({
  id: `v${n}`, version: n, title: `Title ${n}`, body, bodySha256: 'h', criteria: [], createdById: null, createdAt: '2026-01-01T00:00:00.000Z',
  eligibility: { eligible: true, reasons: [] }, recording: null,
  approval: approvalId ? { id: approvalId, approvedById: 'u', approvedByName: 'Ann', approvedByEmail: 'a@b.c', approvedAt: '2026-01-02T00:00:00.000Z' } : null,
});
const spec = (over: Partial<SpecDetail> = {}): SpecDetail => ({
  id: 's1', projectId: 'p1', repoId: 'r1', slug: 'dark-mode', title: 'Dark mode', status: 'draft', currentVersion: 2, approvedVersion: 1,
  createdById: null, updatedById: null, approvedById: null, approvedAt: null, createdAt: '', updatedAt: '', source: null,
  mayApprove: true, mayApproveReasons: [], eligibility: { eligible: true, reasons: [] },
  versions: [version(2, '## Goal\n\nold'), version(1, '## Goal\n\nfirst', 'ap1')], ...over,
});
const draft: SpecDraft = { specId: 's1', title: 'Dark mode', body: '## Goal\n\nnew', expectedVersion: 2 };
const interrupt = (toolName: string, args: unknown) => ({ reason: 'mastra:tool_approval', metadata: { mastra: { toolName, args } } });

describe('specDraftFromInterrupt', () => {
  it('reads a draftSpec approval and ignores everything else', () => {
    expect(specDraftFromInterrupt(interrupt('draftSpec', draft))).toMatchObject({ specId: 's1', expectedVersion: 2 });
    expect(specDraftFromInterrupt(interrupt('createJob', draft))).toBeNull();
    expect(specDraftFromInterrupt(interrupt('draftSpec', { title: 'x', body: 'y' }))).toBeNull();
    expect(specDraftFromInterrupt({ reason: 'mastra:tool_suspend', metadata: { mastra: { toolName: 'draftSpec', args: draft } } })).toBeNull();
  });
});

describe('specPreview', () => {
  it('is ready with the previous version when the expected version is the current one', () => {
    expect(specPreview(draft, spec())).toMatchObject({ state: 'ready', previous: { version: 2, body: '## Goal\n\nold' } });
  });
  it('is loading until the spec arrives, stale when it moved on, and an error for impossible drafts', () => {
    expect(specPreview(draft, null)).toEqual({ state: 'loading' });
    expect(specPreview(draft, spec({ currentVersion: 3 })).state).toBe('stale');
    expect(specPreview({ ...draft, expectedVersion: 0 }, spec()).state).toBe('error');
    expect(specPreview({ ...draft, expectedVersion: 7 }, spec({ currentVersion: 7 })).state).toBe('error');
  });
  it('lets a complete new spec through at version 0 only', () => {
    const fresh: SpecDraft = { projectId: 'p1', repoId: 'r1', slug: 'x', title: 'New one', body: 'b', expectedVersion: 0 };
    expect(specPreview(fresh, null)).toEqual({ state: 'ready', previous: null });
    expect(specPreview({ ...fresh, expectedVersion: 1 }, null).state).toBe('error');
    expect(specPreview({ ...fresh, slug: undefined }, null).state).toBe('error');
  });
});

describe('SpecDraftCard', () => {
  const ready = specPreview(draft, spec());
  it('is clearly a draft save, not an approval, and shows the diff and the rendered proposal', () => {
    const { container } = render(<SpecDraftCard draft={draft} preview={ready} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Draft · not approved')).toBeInTheDocument();
    expect(screen.getByText('Save version 3 as draft?')).toBeInTheDocument();
    expect(screen.getByText(/does not approve the spec/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.getByText('Changes against version 2')).toBeInTheDocument();
    expect(container.querySelector('[data-diff="del"]')).toHaveTextContent('old');
    expect(container.querySelector('[data-diff="add"]')).toHaveTextContent('new');
  });

  it('saves and cancels through the buttons', () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<SpecDraftCard draft={draft} preview={ready} onSave={onSave} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['loading', { state: 'loading' } as const, /Loading the current version/],
    ['error', { state: 'error', message: 'boom' } as const, /Cannot save this draft: boom/],
    ['stale', { state: 'stale', message: 'The spec is now at version 3' } as const, /now at version 3/],
  ])('cannot save while the preview is %s', (_name, preview, text) => {
    const onSave = vi.fn();
    render(<SpecDraftCard draft={draft} preview={preview} onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save draft' });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows raw HTML in the proposal as text and keeps unsafe links inert', () => {
    const body = '<script>alert(1)</script>\n\n[x](javascript:alert(1))';
    const { container } = render(<SpecDraftCard draft={{ ...draft, body }} preview={{ state: 'ready', previous: { version: 2, title: 'T', body: '' } }} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('names a new spec by slug and repo', () => {
    const fresh: SpecDraft = { projectId: 'p1', repoId: 'r1', slug: 'dark-mode', title: 'Dark mode', body: 'b', expectedVersion: 0 };
    render(<SpecDraftCard draft={fresh} preview={{ state: 'ready', previous: null }} repoName="gilde-dev/gilde" onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Save new spec as draft?')).toBeInTheDocument();
    expect(screen.getByText(/dark-mode · gilde-dev\/gilde/)).toBeInTheDocument();
  });
});

describe('CopilotPlanApproval registration', () => {
  const renderInterrupt = () => {
    render(<CopilotPlanApproval />);
    expect(useInterrupt).toHaveBeenCalled();
    return vi.mocked(useInterrupt).mock.calls.at(-1)![0] as never as {
      enabled: (e: { value: unknown }) => boolean;
      render: (a: unknown) => JSX.Element;
    };
  };

  it('is a single registration that also handles draftSpec', () => {
    vi.mocked(useInterrupt).mockClear();
    const reg = renderInterrupt();
    expect(vi.mocked(useInterrupt)).toHaveBeenCalledTimes(1);
    expect(reg.enabled({ value: interrupt('draftSpec', draft) })).toBe(true);
    expect(reg.enabled({ value: interrupt('createJob', { title: 'x', task: 'y' }) })).toBe(true);
    expect(reg.enabled({ value: interrupt('somethingElse', draft) })).toBe(false);
  });

  it('loads the current version, shows the diff, then saves with { approved: true } only after it matches', async () => {
    vi.mocked(api.getSpec).mockResolvedValue(spec());
    const reg = renderInterrupt();
    const resolve = vi.fn();
    render(reg.render({ interrupt: interrupt('draftSpec', draft), resolve, cancel: vi.fn() }));
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled());
    expect(api.getSpec).toHaveBeenCalledWith('s1');
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(resolve).toHaveBeenCalledWith({ approved: true });
  });

  it('cannot save when the spec moved on or failed to load, and cancel declines', async () => {
    const reg = renderInterrupt();
    vi.mocked(api.getSpec).mockResolvedValueOnce(spec({ currentVersion: 3 }));
    const cancel = vi.fn();
    const resolve = vi.fn();
    const view = render(reg.render({ interrupt: interrupt('draftSpec', draft), resolve, cancel }));
    await waitFor(() => expect(screen.getByText(/now at version 3/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    view.unmount();

    vi.mocked(api.getSpec).mockRejectedValueOnce(new Error('network down'));
    render(reg.render({ interrupt: interrupt('draftSpec', draft), resolve, cancel }));
    await waitFor(() => expect(screen.getByText(/network down/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });

  it('keeps the existing createJob and createPlannedFeature cards', () => {
    vi.mocked(api.getRepo).mockResolvedValue({ fullName: 'gilde-dev/gilde' } as never);
    const reg = renderInterrupt();
    render(reg.render({ interrupt: interrupt('createJob', { repoId: 'r1', title: 'Add endpoint', task: 'x', acceptanceCriteria: [], dependsOn: [] }), resolve: vi.fn(), cancel: vi.fn() }));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });
});

describe('spec-linked plans', () => {
  const plan: FeaturePlan = {
    projectId: 'p1', specId: 's1', specApproval: { version: 1, approvalId: 'ap1' }, title: 'Dark mode', spec: 's', acceptanceCriteria: ['c'],
    jobs: [{ key: 'api', repoId: 'r1', title: 'Job', task: 'task', acceptanceCriteria: ['x'], dependsOn: [] }],
  };

  it('carries the spec link from the interrupt', () => {
    expect(planFromInterrupt(interrupt('createPlannedFeature', plan))).toMatchObject({ specId: 's1', specApproval: { version: 1, approvalId: 'ap1' } });
    expect(planFromInterrupt(interrupt('createPlannedFeature', { ...plan, specId: undefined, specApproval: undefined }))).not.toHaveProperty('specId');
  });

  it('computes the pin: current, superseded or with another approval', () => {
    expect(planPin({ version: 1, approvalId: 'ap1' }, spec())).toMatchObject({ state: 'current' });
    expect(planPin({ version: 1, approvalId: 'ap1' }, spec({ approvedVersion: 2 })).state).toBe('stale');
    expect(planPin({ version: 1, approvalId: 'other' }, spec()).state).toBe('stale');
  });

  it('can only be approved once the pin is known to be current', () => {
    const onApprove = vi.fn();
    const { rerender } = render(<PlanApprovalCard plan={plan} pin={{ state: 'loading' }} onApprove={onApprove} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    rerender(<PlanApprovalCard plan={plan} pin={{ state: 'stale', message: 'moved on' }} onApprove={onApprove} onCancel={vi.fn()} />);
    expect(screen.getByText('moved on')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    rerender(<PlanApprovalCard plan={plan} pin={{ state: 'error', message: 'down' }} onApprove={onApprove} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    rerender(<PlanApprovalCard plan={plan} pin={{ state: 'current', label: 'Dark mode (dark-mode), approved version 1' }} onApprove={onApprove} onCancel={vi.fn()} />);
    expect(screen.getByText(/Pinned to/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('keeps plans without a spec approvable as before', () => {
    render(<PlanApprovalCard plan={{ ...plan, specId: undefined, specApproval: undefined }} onApprove={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.queryByText(/Pinned to/)).toBeNull();
  });

  it('checks the pin against the spec when rendered through the registration', async () => {
    vi.mocked(api.getSpec).mockResolvedValue(spec({ approvedVersion: 2 }));
    vi.mocked(api.listRepos).mockResolvedValue([] as never);
    render(<CopilotPlanApproval />);
    const reg = vi.mocked(useInterrupt).mock.calls.at(-1)![0] as never as { render: (a: unknown) => JSX.Element };
    render(reg.render({ interrupt: interrupt('createPlannedFeature', plan), resolve: vi.fn(), cancel: vi.fn() }));
    await waitFor(() => expect(screen.getByText(/now at approved version 2/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });
});
