import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Lesson } from '@/lib/api';
import { LessonsView, sortLessons } from './lessons-view';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const lesson = (over: Partial<Lesson>): Lesson => ({
  id: 'l1',
  projectId: 'p1',
  text: 'Lesson one',
  status: 'candidate',
  targetKind: null,
  targetRepoId: null,
  note: null,
  appliedJobId: null,
  appliedJobPrUrl: null,
  appliedAt: null,
  sources: [],
  sourceCount: 1,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...over,
});

const src = (over: object = {}) => ({
  id: 's1', kind: 'retro' as const, jobId: 'j1', runId: 'r1', feedbackId: null, excerpt: 'Tests were slow',
  prUrl: 'https://github.com/o/r/pull/7', createdAt: '2026-10-01T10:00:00.000Z', ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'listProjects').mockResolvedValue([{ id: 'p1', name: 'Proj' } as never]);
  vi.spyOn(api, 'listRepos').mockResolvedValue([{ id: 'r1', fullName: 'o/r' } as never]);
});

describe('sortLessons', () => {
  it('sorts by sourceCount descending, then newest', () => {
    const a = lesson({ id: 'a', sourceCount: 1, createdAt: '2026-10-01T00:00:00.000Z' });
    const b = lesson({ id: 'b', sourceCount: 3, createdAt: '2026-09-01T00:00:00.000Z' });
    const c = lesson({ id: 'c', sourceCount: 1, createdAt: '2026-10-02T00:00:00.000Z' });
    expect(sortLessons([a, b, c]).map((l) => l.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('LessonsView', () => {
  it('renders the empty state', async () => {
    vi.spyOn(api, 'listLessons').mockResolvedValue([]);
    render(<LessonsView />);
    expect(await screen.findByText(/No lessons yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Lessons' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('tab', { name: 'candidate (0)' })).toBeInTheDocument();
  });

  it('renders lessons with counts, badge, sources and the PR link', async () => {
    vi.spyOn(api, 'listLessons').mockResolvedValue([
      lesson({ id: 'l1', text: 'Few', sourceCount: 1, sources: [src()] }),
      lesson({ id: 'l2', text: 'Many', sourceCount: 4 }),
      lesson({ id: 'l3', text: 'Done', status: 'approved', targetKind: 'skill' }),
    ]);
    render(<LessonsView />);
    const items = await screen.findAllByRole('listitem', { name: /Few|Many/ });
    expect(items.map((i) => within(i).getByLabelText('Lesson text')).map((t) => (t as HTMLTextAreaElement).value)).toEqual(['Many', 'Few']);
    expect(screen.getByRole('tab', { name: 'candidate (2)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'approved (1)' })).toBeInTheDocument();
    expect(within(items[0]).getByText('4 jobs')).toBeInTheDocument();
    fireEvent.click(within(items[1]).getByRole('button', { name: /Show sources/ }));
    expect(within(items[1]).getByText('Tests were slow')).toBeInTheDocument();
    expect(within(items[1]).getByRole('link', { name: 'PR' })).toHaveAttribute('href', 'https://github.com/o/r/pull/7');
    fireEvent.click(screen.getByRole('tab', { name: 'approved (1)' }));
    expect(screen.getByLabelText('Target kind')).toHaveValue('skill');
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
  });

  it('collects, saves edits and changes status', async () => {
    const list = vi.spyOn(api, 'listLessons').mockResolvedValue([lesson({})]);
    const collect = vi.spyOn(api, 'collectLessons').mockResolvedValue({ created: 2 });
    const update = vi.spyOn(api, 'updateLesson').mockResolvedValue(lesson({}));
    const status = vi.spyOn(api, 'setLessonStatus').mockResolvedValue(lesson({}));
    render(<LessonsView />);
    await screen.findByLabelText('Lesson text');
    fireEvent.click(screen.getByRole('button', { name: 'Collect now' }));
    expect(await screen.findByText('Collected 2 new lessons')).toBeInTheDocument();
    expect(collect).toHaveBeenCalled();
    expect(list.mock.calls.length).toBeGreaterThan(1);

    const text = screen.getByLabelText('Lesson text');
    fireEvent.change(text, { target: { value: 'Edited' } });
    fireEvent.blur(text);
    await waitFor(() => expect(update).toHaveBeenCalledWith('l1', { text: 'Edited' }));
    fireEvent.change(screen.getByLabelText('Target kind'), { target: { value: 'agents_md' } });
    await waitFor(() => expect(update).toHaveBeenCalledWith('l1', { targetKind: 'agents_md' }));
    fireEvent.change(screen.getByLabelText('Target repo'), { target: { value: 'r1' } });
    await waitFor(() => expect(update).toHaveBeenCalledWith('l1', { targetRepoId: 'r1' }));

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(status).toHaveBeenCalledWith('l1', 'approve'));
  });

  it('shows the API error when approving fails', async () => {
    vi.spyOn(api, 'listLessons').mockResolvedValue([lesson({})]);
    vi.spyOn(api, 'setLessonStatus').mockRejectedValue(new Error('targetKind is required'));
    render(<LessonsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('targetKind is required');
  });

  it('merges the selected lessons into the chosen one', async () => {
    vi.spyOn(api, 'listLessons').mockResolvedValue([
      lesson({ id: 'a', text: 'Alpha', sourceCount: 2 }),
      lesson({ id: 'b', text: 'Beta', sourceCount: 1 }),
    ]);
    const merge = vi.spyOn(api, 'mergeLessons').mockResolvedValue(lesson({}));
    render(<LessonsView />);
    const boxes = await screen.findAllByLabelText('Select lesson');
    fireEvent.click(boxes[0]);
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();
    fireEvent.click(boxes[1]);
    fireEvent.change(screen.getByLabelText('Merge into…'), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(merge).toHaveBeenCalledWith('a', ['b']));
  });

  it('applies an approved skill lesson with a target repo, and marks it applied by hand', async () => {
    vi.spyOn(api, 'listLessons').mockResolvedValue([
      lesson({ id: 'ok', text: 'Ready', status: 'approved', targetKind: 'skill', targetRepoId: 'r1' }),
      lesson({ id: 'norepo', text: 'No repo', status: 'approved', targetKind: 'skill' }),
      lesson({ id: 'prompt', text: 'Prompt', status: 'approved', targetKind: 'routine_prompt', targetRepoId: 'r1' }),
    ]);
    const apply = vi.spyOn(api, 'applyLesson').mockResolvedValue(lesson({}));
    const mark = vi.spyOn(api, 'markLessonApplied').mockResolvedValue(lesson({}));
    render(<LessonsView />);
    fireEvent.click(await screen.findByRole('tab', { name: 'approved (3)' }));
    const ready = screen.getByRole('listitem', { name: 'Ready' });
    expect(within(screen.getByRole('listitem', { name: 'No repo' })).getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(within(screen.getByRole('listitem', { name: 'Prompt' })).getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(within(screen.getByRole('listitem', { name: 'Prompt' })).getByRole('button', { name: 'Mark applied' })).toBeEnabled();
    fireEvent.click(within(ready).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith('ok'));
    fireEvent.click(within(ready).getByRole('button', { name: 'Mark applied' }));
    await waitFor(() => expect(mark).toHaveBeenCalledWith('ok'));
  });

  it('shows the job, PR and applied date on applying and applied lessons', async () => {
    vi.spyOn(api, 'listLessons').mockResolvedValue([
      lesson({ id: 'a', text: 'In flight', status: 'applying', appliedJobId: 'abcdef1234', appliedJobPrUrl: 'https://github.com/o/r/pull/9' }),
      lesson({ id: 'b', text: 'Finished', status: 'applied', appliedJobId: 'fedcba4321', appliedAt: '2026-10-02T10:00:00.000Z' }),
    ]);
    render(<LessonsView />);
    fireEvent.click(await screen.findByRole('tab', { name: 'applying (1)' }));
    const inFlight = screen.getByRole('listitem', { name: 'In flight' });
    expect(within(inFlight).getByText('Job abcdef12')).toBeInTheDocument();
    expect(within(inFlight).getByRole('link', { name: 'PR' })).toHaveAttribute('href', 'https://github.com/o/r/pull/9');
    expect(within(inFlight).queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'applied (1)' }));
    const finished = screen.getByRole('listitem', { name: 'Finished' });
    expect(within(finished).getByText(/^Applied /)).toBeInTheDocument();
    expect(within(finished).queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
  });
});
