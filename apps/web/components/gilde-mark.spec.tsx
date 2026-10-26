import { render } from '@testing-library/react';
import { GildeLogoTile, GildeMark } from './gilde-mark';

describe('GildeMark', () => {
  it('is decorative and follows the text colour', () => {
    const { container } = render(<GildeMark size={24} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('width', '24');
    const path = svg.querySelector('path')!;
    expect(path).toHaveAttribute('fill', 'currentColor');
    // Door and window are holes in one path.
    expect(path).toHaveAttribute('fill-rule', 'evenodd');
  });

  it('renders the tile on the brand gradient at the requested size', () => {
    const { container } = render(<GildeLogoTile size={40} />);
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.className).toContain('bg-primary-gradient');
    expect(tile.style.width).toBe('40px');
    expect(tile.querySelector('svg')).toHaveAttribute('width', '26');
  });
});
