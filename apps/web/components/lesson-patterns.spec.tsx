import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type LessonPattern } from '@/lib/api';
import { LessonPatternsPanel } from './lesson-patterns';
import { LessonsView } from './lessons-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

const member = (lessonId: string, text: string) => ({
  lessonId, text, status: 'candidate' as const,
  sources: [{ id: `s-${lessonId}`, kind: 'suggested_lesson' as const, jobId: 'job12345-aaaa', runId: null, feedbackId: null, excerpt: 'x', prUrl: 'https://github.com/o/r/pull/1', createdAt: '2026-10-01T10:00:00.000Z' }],
});

const pattern = (over: Partial<LessonPattern> = {}): LessonPattern => ({
  id: 'pat1',
  representativeText: 'Run pnpm install first',
  size: 2,
  members: [member('l1', 'Run pnpm install first'), member('l2', 'Always run pnpm install')],
  jobIds: ['j1', 'j2'],
  runIds: [],
  repoIds: ['r1'],
  firstSeen: '2026-09-01T10:00:00.000Z',
  lastSeen: '2026-10-01T10:00:00.000Z',
  alreadyCovered: [],
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('LessonPatternsPanel', () => {
  it('shows the empty state', async () => {
    vi.spyOn(api, 'listLessonPatterns').mockResolvedValue({ method: 'text', threshold: 0.6, patterns: [] });
    render(<LessonPatternsPanel projectId="p1" onMerged={vi.fn()} />);
    expect(await screen.findByText(/No patterns yet/)).toBeInTheDocument();
  });

  it('shows a pattern, expands it to lessons with PR links and notes the covered ones', async () => {
    vi.spyOn(api, 'listLessonPatterns').mockResolvedValue({
      method: 'embeddings', threshold: 0.85,
      patterns: [pattern({ alreadyCovered: [{ lessonId: 'l9', text: 'Already in AGENTS.md', status: 'applied', appliedJobId: null }] })],
    });
    render(<LessonPatternsPanel projectId="p1" onMerged={vi.fn()} />);
    expect(await screen.findByText('2 lessons')).toBeInTheDocument();
    expect(screen.getByText('2 jobs')).toBeInTheDocument();
    expect(screen.getByText('1 repo')).toBeInTheDocument();
    expect(screen.getByText('Already in AGENTS.md')).toBeInTheDocument();
    expect(screen.getByText(/embedding similarity/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show lessons \(2\)/ }));
    expect(screen.getAllByRole('link', { name: 'PR' })[0]).toHaveAttribute('href', 'https://github.com/o/r/pull/1');
  });

  it('pre-fills the merge with the representative lesson and the pattern\'s lessons', async () => {
    vi.spyOn(api, 'listLessonPatterns').mockResolvedValue({
      method: 'text', threshold: 0.6,
      patterns: [pattern({ representativeText: 'Always run pnpm install' })],
    });
    const merge = vi.spyOn(api, 'mergeLessons').mockResolvedValue({} as never);
    const onMerged = vi.fn();
    render(<LessonPatternsPanel projectId="p1" onMerged={onMerged} />);
    fireEvent.click(await screen.findByRole('button', { name: /Show lessons/ }));
    expect((screen.getByLabelText('Merge into…') as HTMLSelectElement).value).toBe('l2');
    fireEvent.click(screen.getByRole('button', { name: 'Merge 2 lessons' }));
    await waitFor(() => expect(merge).toHaveBeenCalledWith('l2', ['l1']));
    await waitFor(() => expect(onMerged).toHaveBeenCalled());
  });

  it('shows a merge failure', async () => {
    vi.spyOn(api, 'listLessonPatterns').mockResolvedValue({ method: 'text', threshold: 0.6, patterns: [pattern()] });
    vi.spyOn(api, 'mergeLessons').mockRejectedValue(new Error('Lesson l1 is applying'));
    render(<LessonPatternsPanel projectId="p1" onMerged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Show lessons/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Merge 2 lessons' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Lesson l1 is applying');
  });
});

describe('LessonsView patterns toggle', () => {
  it('switches between the list and the patterns view', async () => {
    vi.spyOn(api, 'listProjects').mockResolvedValue([{ id: 'p1', name: 'Proj' } as never]);
    vi.spyOn(api, 'listRepos').mockResolvedValue([]);
    vi.spyOn(api, 'listLessons').mockResolvedValue([]);
    const patterns = vi.spyOn(api, 'listLessonPatterns').mockResolvedValue({ method: 'text', threshold: 0.6, patterns: [pattern()] });
    render(<LessonsView />);
    expect(await screen.findByRole('tab', { name: 'candidate (0)' })).toBeInTheDocument();
    expect(patterns).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Patterns' }));
    expect(await screen.findByText('2 lessons')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'candidate (0)' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(await screen.findByRole('tab', { name: 'candidate (0)' })).toBeInTheDocument();
  });
});
