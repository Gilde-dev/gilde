import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiKey } from '@/lib/api';
import { ApiKeysView } from './api-keys-view';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const key = (over: Partial<ApiKey> = {}): ApiKey => ({
  id: 'k1',
  name: 'chat bot',
  prefix: 'abcd1234',
  createdAt: '2026-10-01T10:00:00.000Z',
  lastUsedAt: null,
  expiresAt: null,
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'me').mockResolvedValue({ id: 'u1', name: 'Pascal', email: 'p@x.nl' });
  vi.spyOn(api, 'listRevisions').mockResolvedValue([]);
});

describe('ApiKeysView', () => {
  it('lists keys with their prefix', async () => {
    vi.spyOn(api, 'listApiKeys').mockResolvedValue([key()]);
    render(<ApiKeysView />);
    expect(await screen.findByText('chat bot')).toBeInTheDocument();
    expect(screen.getByText('gk_abcd1234')).toBeInTheDocument();
  });

  it('creates a key and shows it once with a warning', async () => {
    const list = vi.spyOn(api, 'listApiKeys').mockResolvedValue([]);
    const create = vi.spyOn(api, 'createApiKey').mockResolvedValue({
      id: 'k1', name: 'bot', prefix: 'abcd1234', key: 'gk_abcd1234_secret', expiresAt: null,
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<ApiKeysView />);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'bot' } });
    fireEvent.change(screen.getByLabelText(/Expires in/), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    expect(await screen.findByText('gk_abcd1234_secret')).toBeInTheDocument();
    expect(screen.getByText(/shown only once/)).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith({ name: 'bot', expiresInDays: 30 });

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('gk_abcd1234_secret'));

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('gk_abcd1234_secret')).not.toBeInTheDocument();
    expect(list).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('revokes a key', async () => {
    vi.spyOn(api, 'listApiKeys').mockResolvedValue([key()]);
    const revoke = vi.spyOn(api, 'revokeApiKey').mockResolvedValue(undefined);
    render(<ApiKeysView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke chat bot' }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('k1'));
  });
});
