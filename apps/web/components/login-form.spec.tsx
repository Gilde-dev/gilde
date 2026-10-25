import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginForm } from './login-form';

let next: string | null = null;
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(next ? { next } : {}) }));

const assign = vi.fn();

beforeEach(() => {
  next = null;
  assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => vi.unstubAllGlobals());

function submit() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.nl' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
}

describe('LoginForm', () => {
  it('posts the credentials and goes to next on success', async () => {
    next = '/features?x=1';
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginForm />);
    submit();
    expect(await screen.findByRole('button', { name: 'Logging in…' })).toBeDisabled();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/features?x=1'));
    expect(fetchMock).toHaveBeenCalledWith('/auth/login', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ email: 'a@b.nl', password: 'secret' });
  });

  it('ignores an external next', async () => {
    next = '//evil.example';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    render(<LoginForm />);
    submit();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('shows an error for a wrong password', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"message":"x"}', { status: 401 })));
    render(<LoginForm />);
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeEnabled();
  });

  it('shows an error for 429', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })));
    render(<LoginForm />);
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts');
  });
});
