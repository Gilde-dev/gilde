import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type AdminUser } from '@/lib/api';
import { UsersView } from './users-view';

const user = (over: Partial<AdminUser> = {}): AdminUser => ({
  id: 'u2', name: 'Kim', email: 'kim@x.test', isBot: false, isAdmin: false, deactivatedAt: null, createdAt: '2026-10-01T10:00:00.000Z', ...over,
});
const me = user({ id: 'u1', name: 'Pascal', email: 'p@x.test', isAdmin: true });

beforeEach(() => {
  vi.spyOn(api, 'me').mockResolvedValue({ id: 'u1', name: 'Pascal', email: 'p@x.test', isAdmin: true });
});
afterEach(() => vi.restoreAllMocks());

describe('UsersView', () => {
  it('tells non-admins it is for admins only and does not list users', async () => {
    vi.spyOn(api, 'me').mockResolvedValue({ id: 'u2', name: 'Kim', email: 'k@x.test', isAdmin: false });
    const list = vi.spyOn(api, 'listUsers');
    render(<UsersView />);
    expect(await screen.findByText(/Admins only/)).toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
  });

  it('lists users with badges', async () => {
    vi.spyOn(api, 'listUsers').mockResolvedValue([me, user({ isBot: true, name: 'Botty', id: 'b1' }), user({ id: 'u3', name: 'Off', deactivatedAt: '2026-10-02T10:00:00.000Z' })]);
    render(<UsersView />);
    expect(await screen.findByText('Botty')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.getByText('bot')).toBeInTheDocument();
    expect(screen.getByText('deactivated')).toBeInTheDocument();
  });

  it('creates a user and shows the setup link once, copyable', async () => {
    const list = vi.spyOn(api, 'listUsers').mockResolvedValue([me]);
    const invite = vi.spyOn(api, 'inviteUser').mockResolvedValue({ user: user(), setupLink: 'https://gilde.test/setup?token=abc', expiresAt: '2026-10-31T10:00:00.000Z' });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<UsersView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create user' }));
    const form = within(await screen.findByRole('form', { name: 'Create user' }));
    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'Kim' } });
    fireEvent.change(form.getByLabelText('Email'), { target: { value: 'kim@x.test' } });
    fireEvent.click(form.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(invite).toHaveBeenCalledWith({ name: 'Kim', email: 'kim@x.test' }));
    expect(await screen.findByText('https://gilde.test/setup?token=abc')).toBeInTheDocument();
    expect(screen.getByText(/shown only once/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://gilde.test/setup?token=abc'));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('https://gilde.test/setup?token=abc')).not.toBeInTheDocument();
    expect(list).toHaveBeenCalled();
  });

  it('shows a 409 when the email is taken', async () => {
    vi.spyOn(api, 'listUsers').mockResolvedValue([me]);
    vi.spyOn(api, 'inviteUser').mockRejectedValue(new ApiError('POST failed: 409', 409, 'Email already in use'));
    render(<UsersView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create user' }));
    const form = within(await screen.findByRole('form', { name: 'Create user' }));
    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'Kim' } });
    fireEvent.change(form.getByLabelText('Email'), { target: { value: 'kim@x.test' } });
    fireEvent.click(form.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Email already in use')).toBeInTheDocument();
  });

  it('issues a reset link', async () => {
    vi.spyOn(api, 'listUsers').mockResolvedValue([me, user()]);
    const reset = vi.spyOn(api, 'createUserResetLink').mockResolvedValue({ user: user(), setupLink: 'https://gilde.test/setup?token=r', expiresAt: '2026-10-31T10:00:00.000Z' });
    render(<UsersView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset link for Kim' }));
    await waitFor(() => expect(reset).toHaveBeenCalledWith('u2'));
    expect(await screen.findByText('https://gilde.test/setup?token=r')).toBeInTheDocument();
  });

  it('deactivates only after confirming, and reactivates', async () => {
    const list = vi.spyOn(api, 'listUsers').mockResolvedValue([me, user()]);
    const deactivate = vi.spyOn(api, 'deactivateUser').mockResolvedValue(user({ deactivatedAt: '2026-10-02T10:00:00.000Z' }));
    render(<UsersView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate Kim' }));
    expect(deactivate).not.toHaveBeenCalled();
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/API keys stop working and their executors stop/)).toBeInTheDocument();
    expect(dialog.getByText(/history .* stays/)).toBeInTheDocument();
    list.mockResolvedValue([me, user({ deactivatedAt: '2026-10-02T10:00:00.000Z' })]);
    fireEvent.click(dialog.getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(deactivate).toHaveBeenCalledWith('u2'));
    const reactivate = vi.spyOn(api, 'reactivateUser').mockResolvedValue(user());
    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate Kim' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reactivate' }));
    await waitFor(() => expect(reactivate).toHaveBeenCalledWith('u2'));
  });

  it('shows a refused deactivation (409)', async () => {
    vi.spyOn(api, 'listUsers').mockResolvedValue([me, user()]);
    vi.spyOn(api, 'deactivateUser').mockRejectedValue(new ApiError('failed', 409, 'The last admin cannot be deactivated'));
    render(<UsersView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate Kim' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The last admin cannot be deactivated');
  });

  it('shows a 403 clearly', async () => {
    vi.spyOn(api, 'listUsers').mockResolvedValue([me, user()]);
    vi.spyOn(api, 'setUserAdmin').mockRejectedValue(new ApiError('failed', 403, 'Forbidden'));
    render(<UsersView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make admin Kim' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only admins can manage users.');
  });

  it('grants admin, and disables the guarded actions with a reason', async () => {
    vi.spyOn(api, 'listUsers').mockResolvedValue([me, user()]);
    const setAdmin = vi.spyOn(api, 'setUserAdmin').mockResolvedValue(user({ isAdmin: true }));
    render(<UsersView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make admin Kim' }));
    await waitFor(() => expect(setAdmin).toHaveBeenCalledWith('u2', true));
    // you are the last admin and yourself
    expect(screen.getByRole('button', { name: 'Deactivate Pascal' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove admin Pascal' })).toBeDisabled();
    expect(screen.getByText(/You cannot deactivate yourself/)).toBeInTheDocument();
    expect(screen.getByText(/The last admin cannot be removed/)).toBeInTheDocument();
  });

  it('creates a bot user through the bots endpoint and refreshes', async () => {
    const list = vi.spyOn(api, 'listUsers').mockResolvedValue([me]);
    const bot = vi.spyOn(api, 'createBotUser').mockResolvedValue({ id: 'b9', name: 'Botty', email: 'botty@x.test', isBot: true });
    render(<UsersView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create bot user' }));
    const form = within(await screen.findByRole('form', { name: 'Create bot user' }));
    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'Botty' } });
    fireEvent.change(form.getByLabelText('Email'), { target: { value: 'botty@x.test' } });
    fireEvent.click(form.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(bot).toHaveBeenCalledWith({ name: 'Botty', email: 'botty@x.test' }));
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1));
  });
});
