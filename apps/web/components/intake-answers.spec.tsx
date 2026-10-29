import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { intakeComment, intakeItem } from './intake.fixture';
import { COLLAPSED_CHARS, IntakeAnswers } from './intake-answers';

afterEach(() => vi.restoreAllMocks());

const detail = (comments: ReturnType<typeof intakeComment>[]) => vi.spyOn(api, 'getIntake').mockResolvedValue({ ...intakeItem(), comments });

describe('IntakeAnswers', () => {
  it('loads on demand and shows author, time, body and a GitHub link, in the given order', async () => {
    const spy = detail([intakeComment(), intakeComment({ id: '6', author: 'cy', body: 'second' })]);
    render(<IntakeAnswers itemId="i1" />);
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show answers' }));
    expect(await screen.findByText('@bob')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith('i1');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Use a comma'), expect.stringContaining('second'),
    ]);
    expect(screen.getAllByRole('link', { name: 'View on GitHub' })[0]).toHaveAttribute('href', 'https://github.com/o/web/issues/12#issuecomment-5');
  });

  it('renders an HTML or script body as escaped text', async () => {
    const body = '<script>window.hacked=1</script><img src=x onerror=alert(1)>';
    detail([intakeComment({ body })]);
    const { container } = render(<IntakeAnswers itemId="i1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show answers' }));
    expect(await screen.findByText(body)).toBeInTheDocument();
    expect(container.querySelector('script, img')).toBeNull();
  });

  it('collapses long bodies behind show more', async () => {
    const body = 'x'.repeat(4000);
    detail([intakeComment({ body })]);
    render(<IntakeAnswers itemId="i1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show answers' }));
    await screen.findByText('@bob');
    expect(screen.queryByText(body)).toBeNull();
    expect(screen.getByText(`${'x'.repeat(COLLAPSED_CHARS)}…`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByText(body)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.queryByText(body)).toBeNull();
  });

  it('shows an error when loading fails', async () => {
    vi.spyOn(api, 'getIntake').mockRejectedValue(new Error('x'));
    render(<IntakeAnswers itemId="i1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show answers' }));
    expect(await screen.findByText('Could not load the answers.')).toBeInTheDocument();
  });
});
