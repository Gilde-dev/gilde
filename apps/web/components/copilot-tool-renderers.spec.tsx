import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@copilotkit/react-core/v2/headless', () => ({ useAgent: vi.fn(), useRenderTool: vi.fn() }));
vi.mock('@copilotkit/react-ui', () => ({ AssistantMessage: () => null, UserMessage: () => null, ImageRenderer: () => null, CopilotSidebar: () => null }));

import { BusyIndicator, GroupedMessage, ToolCallGroup, ToolCallView, toolError, toolLabel } from './copilot-tool-renderers';

describe('toolLabel', () => {
  it('labels known tools and falls back to the tool name', () => {
    expect(toolLabel('searchRepoCode', {})).toBe('Searching code');
    expect(toolLabel('readRepoFile', { path: 'a/b.ts', startLine: 3, endLine: 9 })).toBe('Reading a/b.ts lines 3-9');
    expect(toolLabel('listJobs', {})).toBe('Looking up jobs');
    expect(toolLabel('planFeature', {})).toBe('Checking the plan');
    expect(toolLabel('somethingNew', {})).toBe('somethingNew');
  });
});

describe('toolError', () => {
  it('reads thrown errors from text and json', () => {
    expect(toolError('Error: boom')).toBe('boom'.replace('boom', 'Error: boom'));
    expect(toolError('{"error":"nope"}')).toBe('nope');
    expect(toolError('{"ok":true}')).toBeNull();
    expect(toolError(undefined)).toBeNull();
  });
});

describe('ToolCallView (default)', () => {
  it('shows a spinner while running', () => {
    render(<ToolCallView name="mystery" parameters={{ a: 1 }} status="executing" />);
    expect(screen.getByText('mystery')).toBeInTheDocument();
    expect(screen.getByLabelText('Running')).toBeInTheDocument();
    expect(screen.getByTestId('tool-call')).toHaveAttribute('data-status', 'executing');
  });

  it('shows a check when done and expands arguments and a truncated result', () => {
    const result = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    render(<ToolCallView name="mystery" parameters={{ a: 1 }} status="complete" result={JSON.stringify(result)} />);
    expect(screen.getByLabelText('Done')).toBeInTheDocument();
    expect(screen.queryByText('Arguments')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByText('Arguments')).toBeInTheDocument();
    expect(screen.getByText(/"a": 1/)).toBeInTheDocument();
    expect(screen.getByText(/14 more lines/)).toBeInTheDocument();
    expect(screen.queryByText(/line 19/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));
    expect(screen.queryByText('Arguments')).not.toBeInTheDocument();
  });

  it('shows a red mark and the message on error', () => {
    render(<ToolCallView name="mystery" parameters={{}} status="complete" result='{"error":"repo not found"}' />);
    expect(screen.getByLabelText('Failed')).toBeInTheDocument();
    expect(screen.getByText('repo not found')).toBeInTheDocument();
    expect(screen.getByTestId('tool-call')).toHaveAttribute('data-status', 'error');
  });
});

describe('ToolCallView (specific)', () => {
  it('searchRepoCode shows the query, the match count and the first paths', () => {
    const matches = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'a.ts'].map((path, line) => ({ path, line, text: 'x', context: [] }));
    render(<ToolCallView name="searchRepoCode" parameters={{ query: 'retryOrPark' }} status="complete" result={JSON.stringify({ matches, truncated: false })} />);
    expect(screen.getByText('retryOrPark')).toBeInTheDocument();
    expect(screen.getByText(/5 matches/)).toBeInTheDocument();
    expect(screen.getByText('a.ts, b.ts, c.ts')).toBeInTheDocument();
  });

  it('readRepoFile shows the path and line range', () => {
    const result = JSON.stringify({ found: true, path: 'src/x.ts', content: '', startLine: 10, endLine: 20, totalLines: 99 });
    render(<ToolCallView name="readRepoFile" parameters={{ path: 'src/x.ts', startLine: 10, endLine: 20 }} status="complete" result={result} />);
    expect(screen.getByText('src/x.ts')).toBeInTheDocument();
    expect(screen.getByText(/lines 10-20/, { selector: 'p' })).toBeInTheDocument();
  });

  it('listJobs shows titles with status badges', () => {
    const result = JSON.stringify([
      { id: '1', title: 'Add health', status: 'merged' },
      { id: '2', title: 'Fix cron', status: 'parked' },
    ]);
    render(<ToolCallView name="listJobs" parameters={{}} status="complete" result={result} />);
    expect(screen.getByText('Add health')).toBeInTheDocument();
    expect(screen.getByText('merged')).toHaveClass('bg-emerald-100');
    expect(screen.getByText('parked')).toHaveClass('bg-amber-100');
  });

  it('getJob shows the job title and status', () => {
    render(<ToolCallView name="getJob" parameters={{ jobId: '1' }} status="complete" result={JSON.stringify({ id: '1', title: 'One job', status: 'queued' })} />);
    expect(screen.getByText('One job')).toBeInTheDocument();
    expect(screen.getByText('queued')).toBeInTheDocument();
  });

  it('planFeature shows valid, or the list of problems', () => {
    const { unmount } = render(<ToolCallView name="planFeature" parameters={{}} status="complete" result={JSON.stringify({ valid: true, draft: {} })} />);
    expect(screen.getByText('valid')).toBeInTheDocument();
    unmount();
    render(<ToolCallView name="planFeature" parameters={{}} status="complete" result={JSON.stringify({ valid: false, problems: ['cycle between a and b', 'title too short'] })} />);
    expect(screen.getByText('cycle between a and b')).toBeInTheDocument();
    expect(screen.getByText('title too short')).toBeInTheDocument();
  });
});

describe('ToolCallGroup', () => {
  it('keeps steps open while the run is active', () => {
    const { container } = render(<ToolCallGroup steps={3} active><span>step</span></ToolCallGroup>);
    expect(container.querySelector('details')).toBeNull();
    expect(screen.getByText('step')).toBeInTheDocument();
  });

  it('folds finished steps into one collapsible block', () => {
    const { container } = render(<ToolCallGroup steps={3} active={false}><span>step</span></ToolCallGroup>);
    expect(screen.getByText('Worked through 3 steps')).toBeInTheDocument();
    expect(container.querySelector('details')).not.toHaveAttribute('open');
  });
});

describe('GroupedMessage', () => {
  const call = (id: string) => ({ id, role: 'assistant', content: '', toolCalls: [{ id: `t${id}` }], generativeUI: () => <span>ui {id}</span> });
  const messages = [
    { id: 'u', role: 'user', content: 'plan it' },
    call('a'),
    { id: 'ra', role: 'tool', content: '{}' },
    call('b'),
    { id: 'rb', role: 'tool', content: '{}' },
    { id: 'z', role: 'assistant', content: 'Done.' },
  ];
  const renderAt = (index: number, inProgress = false, list: unknown[] = messages) =>
    render(
      <GroupedMessage
        message={list[index] as never}
        messages={list as never}
        index={index}
        inProgress={inProgress}
        isCurrentMessage={index === list.length - 1}
        AssistantMessage={(({ message }: { message: { content: string } }) => <p>{message.content}</p>) as never}
        UserMessage={(({ message }: { message: { content: string } }) => <p>{message.content}</p>) as never}
      />,
    );

  it('draws a finished run of tool steps once, collapsed, from its first message', () => {
    const first = renderAt(1);
    expect(first.getByText('Worked through 2 steps')).toBeInTheDocument();
    expect(first.getByText('ui a')).toBeInTheDocument();
    expect(first.getByText('ui b')).toBeInTheDocument();
    first.unmount();
    for (const i of [2, 3, 4]) {
      const r = renderAt(i);
      expect(r.container).toBeEmptyDOMElement();
      r.unmount();
    }
  });

  it('keeps the run open while it is the tail of an active run', () => {
    const tail = messages.slice(0, 5);
    const r = renderAt(1, true, tail);
    expect(r.queryByText(/Worked through/)).not.toBeInTheDocument();
    expect(r.getByText('ui b')).toBeInTheDocument();
  });

  it('renders user and text messages as usual', () => {
    expect(renderAt(0).getByText('plan it')).toBeInTheDocument();
    expect(renderAt(5).getByText('Done.')).toBeInTheDocument();
  });
});

describe('BusyIndicator', () => {
  it('shows while running, with the step counter', () => {
    const { rerender } = render(<BusyIndicator running step={0} />);
    expect(screen.getByRole('status')).toHaveTextContent('Working…');
    rerender(<BusyIndicator running step={4} />);
    expect(screen.getByRole('status')).toHaveTextContent('Working… step 4');
    rerender(<BusyIndicator running={false} step={4} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
