import { fireEvent, render, screen } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { cn } from '@/lib/utils';
import { Avatar, initials } from './avatar';
import { Badge } from './badge';
import { Button } from './button';
import { EmptyState } from './empty-state';
import { Icon } from './icon';
import { StatCard } from './stat-card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

describe('Icon', () => {
  it.each([14, 16, 20] as const)('renders at %ipx', (size) => {
    const { container } = render(<Icon icon={Inbox} size={size} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('width', String(size));
    expect(svg).toHaveAttribute('height', String(size));
  });

  it('is decorative by default', () => {
    const { container } = render(<Icon icon={Inbox} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('aria-label');
    expect(svg).toHaveAttribute('width', '16');
  });

  it('is an image with a name when labelled', () => {
    render(<Icon icon={Inbox} label="Inbox" />);
    const img = screen.getByRole('img', { name: 'Inbox' });
    expect(img).not.toHaveAttribute('aria-hidden');
  });
});

describe('Button', () => {
  it('renders an optional icon before or after the text, sized to the button', () => {
    const { container, rerender } = render(<Button icon={Inbox}>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' }).firstElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(container.querySelector('svg')).toHaveAttribute('width', '16');
    rerender(
      <Button icon={Inbox} iconPosition="end" size="sm">
        Go
      </Button>,
    );
    expect(screen.getByRole('button').lastElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(container.querySelector('svg')).toHaveAttribute('width', '14');
  });

  it('has no icon by default and keeps disabled', () => {
    const { container } = render(<Button disabled>Go</Button>);
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.getByRole('button')).toBeDisabled();
  });
});

describe('Badge', () => {
  it('shows a dot or an icon, the icon winning', () => {
    const { container, rerender } = render(<Badge>Plain</Badge>);
    expect(container.querySelector('[data-badge-dot]')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
    rerender(<Badge dot variant="success">Dot</Badge>);
    expect(container.querySelector('[data-badge-dot]')).toHaveClass('bg-success-solid');
    rerender(<Badge dot icon={Inbox}>Both</Badge>);
    expect(container.querySelector('svg')).toHaveAttribute('width', '14');
    expect(container.querySelector('[data-badge-dot]')).toBeNull();
  });
});

describe('Avatar', () => {
  it('derives initials', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('ada@example.com')).toBe('AE');
    expect(initials('grace')).toBe('GR');
    expect(initials('  ')).toBe('');
  });

  it.each([20, 24, 32] as const)('renders initials at %ipx', (size) => {
    render(<Avatar name="Ada Lovelace" size={size} />);
    const el = screen.getByRole('img', { name: 'Ada Lovelace' });
    expect(el).toHaveTextContent('AL');
    expect(el).toHaveAttribute('data-size', String(size));
    expect(el).toHaveClass({ 20: 'size-5', 24: 'size-6', 32: 'size-8' }[size]);
  });

  it('falls back to an accessible system avatar', () => {
    const { container } = render(<Avatar />);
    expect(screen.getByRole('img', { name: 'System' })).toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('StatCard', () => {
  it('shows label and value, and delta and hint only when given', () => {
    const { rerender } = render(<StatCard label="In progress" value={3} />);
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.queryByText('+2')).toBeNull();
    rerender(<StatCard label="In progress" value={0} delta="+2" hint="of the loaded jobs" />);
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByText('of the loaded jobs')).toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('shows an optional decorative icon', () => {
    const { container } = render(<EmptyState title="Nothing" icon={Inbox} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '20');
    expect(screen.getByRole('heading', { name: 'Nothing' })).toBeInTheDocument();
  });
});

describe('Tabs', () => {
  function Example({ onChange }: { onChange?: (v: string) => void }) {
    return (
      <Tabs defaultValue="a" onValueChange={onChange}>
        <TabsList aria-label="Sections">
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
          <TabsTrigger value="c">C</TabsTrigger>
        </TabsList>
        <TabsContent value="a">panel a</TabsContent>
        <TabsContent value="b">panel b</TabsContent>
        <TabsContent value="c">panel c</TabsContent>
      </Tabs>
    );
  }

  it('has tab roles, a roving tabindex and linked panels', () => {
    render(<Example />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('panel a');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', screen.getByRole('tab', { name: 'A' }).id);
  });

  it('moves with arrow keys, wraps, and supports Home and End', () => {
    const onChange = vi.fn();
    render(<Example onChange={onChange} />);
    screen.getByRole('tab', { name: 'A' }).focus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'B' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('panel b');
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'End' });
    expect(screen.getByRole('tab', { name: 'C' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'A' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'C' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'A' })).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('a');
  });
});

describe('cn', () => {
  it('keeps a custom font size next to a text colour but merges two sizes', () => {
    expect(cn('text-md', 'text-foreground')).toBe('text-md text-foreground');
    expect(cn('text-md', 'text-display-sm')).toBe('text-display-sm');
    expect(cn('text-sm', 'text-label')).toBe('text-label');
  });
});
