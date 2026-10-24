import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Project } from '@/lib/api';
import { feature } from './feature.fixture';
import { FeaturesView } from './features-view';

afterEach(() => vi.restoreAllMocks());

describe('FeaturesView', () => {
  it('lists features with status, progress and a ready-to-close badge', async () => {
    vi.spyOn(api, 'listProjects').mockResolvedValue([{ id: 'p', name: 'P' } as Project]);
    const ready = feature({ id: 'f2', title: 'Ready one', progress: { ...feature().progress, readyToClose: true, merged: 2, total: 2 } });
    vi.spyOn(api, 'listFeatures').mockResolvedValue([feature(), ready]);
    render(<FeaturesView />);
    expect(await screen.findByRole('link', { name: 'Checkout flow' })).toHaveAttribute('href', '/features/f1');
    expect(screen.getByText('1/3 merged')).toBeInTheDocument();
    expect(screen.getAllByText('Ready to close')).toHaveLength(1);
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  });
});
