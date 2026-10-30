import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupForm } from './setup-form';

const nav = vi.hoisted(() => ({ token: 'tok' as string | null }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(nav.token ? `token=${nav.token}` : '') }));

const PASSWORD = 'a-long-password';
const fill = (a: string, b: string) => {
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: a } });
  fireEvent.change(screen.getByLabelText('Repeat password'), { target: { value: b } });
  fireEvent.click(screen.getByRole('button', { name: 'Set password and log in' }));
};

beforeEach(() => {
  nav.token = 'tok';
});
afterEach(() => vi.unstubAllGlobals());

describe('SetupForm', () => {
  it('posts the token and password, then goes to the board', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<SetupForm />);
    fill(PASSWORD, PASSWORD);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    expect(fetchMock).toHaveBeenCalledWith('/auth/setup', expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: 'tok', password: PASSWORD }) }));
  });

  it('does not submit mismatching or short passwords', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<SetupForm />);
    fill(PASSWORD, 'something-else-1');
    expect(screen.getByRole('alert')).toHaveTextContent('do not match');
    fill('short', 'short');
    expect(screen.getByRole('alert')).toHaveTextContent('at least 12');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows one generic message for any rejected link', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"message":"Link already used"}', { status: 400 })));
    render(<SetupForm />);
    fill(PASSWORD, PASSWORD);
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid or has expired. Ask an admin for a new link.');
  });

  it('asks for a new link when the token is missing', () => {
    nav.token = null;
    render(<SetupForm />);
    expect(screen.getByRole('alert')).toHaveTextContent('Ask an admin for a new link');
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });
});
