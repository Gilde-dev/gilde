import { fireEvent, render, screen } from '@testing-library/react';
import { THEME_KEY } from '@/lib/theme';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserMenu } from './user-menu';

const me = new Response(JSON.stringify({ id: '1', name: 'Pascal', email: 'p@x.nl' }), { status: 200 });
beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());
const stubMe = () => vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => me.clone()));

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

  it('shows avatar, name and email, and applies the chosen theme', async () => {
    stubMe();
    render(<UserMenu />);
    expect(await screen.findByText('p@x.nl')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Pascal' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), { target: { value: 'dark' } });
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
    fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), { target: { value: 'light' } });
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('compact mode keeps the avatar, an accessible theme choice and log out as icons', async () => {
    stubMe();
    render(<UserMenu compact />);
    expect(await screen.findByRole('img', { name: 'Pascal' })).toBeInTheDocument();
    expect(screen.queryByText('p@x.nl')).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), { target: { value: 'dark' } });
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
  });
});
