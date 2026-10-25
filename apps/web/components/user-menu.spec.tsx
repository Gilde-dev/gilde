import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserMenu } from './user-menu';

afterEach(() => vi.unstubAllGlobals());

describe('UserMenu', () => {
  it('shows the user name and logs out', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const fetchMock = vi.fn().mockImplementation(async (url: string) =>
      url === '/api/gilde/v1/auth/me'
        ? new Response(JSON.stringify({ id: '1', name: 'Pascal', email: 'p@x.nl' }), { status: 200 })
        : new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<UserMenu />);
    expect(await screen.findByText('Pascal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
    expect(fetchMock).toHaveBeenCalledWith('/auth/logout', { method: 'POST' });
  });
});
