import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SafeMarkdown } from './safe-markdown';
import { TextDiffView } from './text-diff-view';

describe('SafeMarkdown', () => {
  it('renders markdown structure', () => {
    const { container } = render(<SafeMarkdown source={'## Goal\n\n- one\n- **two**\n\n`code`'} />);
    expect(screen.getByText('Goal')).toBeInTheDocument();
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('strong')).toHaveTextContent('two');
    expect(container.querySelector('code')).toHaveTextContent('code');
  });

  it('shows raw HTML as text and creates no elements from it', () => {
    const source = 'Before <script>alert(1)</script> <img src=x onerror="alert(2)"> <b onclick="x()">bold</b>\n\n<iframe src="https://evil.example"></iframe>';
    const { container } = render(<SafeMarkdown source={source} />);
    expect(container.querySelector('script, img, iframe, b')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('onerror="alert(2)"');
    expect(container.querySelector('[onclick], [onerror]')).toBeNull();
  });

  it('links only safe protocols and keeps the label of the others as text', () => {
    const { container } = render(
      <SafeMarkdown source={'[ok](https://example.com) [mail](mailto:a@b.c) [rel](docs/x.md) [bad](javascript:alert(1)) [data](data:text/html,x) [mixed](JaVaScRiPt:alert(1))'} />,
    );
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://example.com', 'mailto:a@b.c', 'docs/x.md']);
    expect(container.querySelector('a[href*="javascript" i], a[href^="data"]')).toBeNull();
    for (const label of ['bad', 'data', 'mixed']) expect(screen.getByText(label).tagName).toBe('SPAN');
    const external = container.querySelector('a[href="https://example.com"]');
    expect(external).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  });

  it('does not load images', () => {
    const { container } = render(<SafeMarkdown source={'![tracking pixel](https://evil.example/p.png)'} />);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('TextDiffView', () => {
  it('shows added and removed lines with signs, as text', () => {
    const { container } = render(<TextDiffView before={'keep\nold <b>x</b>'} after={'keep\nnew'} />);
    expect(screen.getByText('1 added, 1 removed')).toBeInTheDocument();
    const del = container.querySelector('[data-diff="del"]');
    expect(del?.textContent).toContain('old <b>x</b>');
    expect(del?.querySelector('b')).toBeNull();
    expect(container.querySelector('[data-diff="add"]')).toHaveTextContent('new');
    expect(container.querySelector('[data-diff="same"]')).toHaveTextContent('keep');
  });

  it('says so when nothing changed or the text is too large', () => {
    const { rerender } = render(<TextDiffView before="a" after="a" />);
    expect(screen.getByText('No changes in the text.')).toBeInTheDocument();
    const big = Array.from({ length: 2001 }, (_, i) => `l${i}`).join('\n');
    rerender(<TextDiffView before={big} after="x" />);
    expect(screen.getByText(/Too large to compare/)).toBeInTheDocument();
  });
});
