import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, type Project, type Repo, type SpecDetail } from '@/lib/api';
import { SpecDetailView } from './spec-detail';
import { approval, recording, specDetail, specVersion } from './spec.fixture';

const nav = vi.hoisted(() => ({ params: { id: 's1' } as Record<string, string>, search: 'project=p' }));
vi.mock('next/navigation', () => ({
  useParams: () => nav.params,
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/specs/s1',
  useSearchParams: () => new URLSearchParams(nav.search),
}));

afterEach(() => {
  vi.restoreAllMocks();
  nav.params = { id: 's1' };
  nav.search = 'project=p';
});

function setup(detail: SpecDetail = specDetail()) {
  vi.spyOn(api, 'listProjects').mockResolvedValue([{ id: 'p', name: 'P' }, { id: 'q', name: 'Q' }] as Project[]);
  vi.spyOn(api, 'listRepos').mockResolvedValue([{ id: 'r1', fullName: 'o/web' } as Repo]);
  return vi.spyOn(api, 'getSpec').mockResolvedValue(detail);
}

describe('SpecDetailView', () => {
  it('shows title, repo, status, versions and navigation that keeps the project', async () => {
    setup(specDetail({ approvedVersion: 1, versions: [specVersion(2), specVersion(1, { approval })] }));
    render(<SpecDetailView />);
    expect(await screen.findByRole('heading', { name: 'Dark mode' })).toBeInTheDocument();
    expect(await screen.findByText('o/web')).toBeInTheDocument();
    expect(screen.getByText('Draft · v1 approved')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Specs' })).toHaveAttribute('href', '/specs?project=p');
    const versions = within(screen.getByRole('navigation', { name: 'Versions' }));
    expect(versions.getByRole('link', { name: 'v2' })).toHaveAttribute('href', '/specs/s1/versions/2?project=p');
    expect(versions.getByRole('link', { name: /v1/ })).toHaveAttribute('href', '/specs/s1/versions/1?project=p');
    expect(screen.getByRole('heading', { name: 'Version 2: Title 2' })).toBeInTheDocument();
    expect(document.querySelector('main')).toBeNull();
  });

  it('shows loading, error and a missing version without fabricated data', async () => {
    const get = vi.spyOn(api, 'getSpec').mockRejectedValue(new Error('Spec not found'));
    vi.spyOn(api, 'listProjects').mockResolvedValue([]);
    render(<SpecDetailView />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Spec not found');
    get.mockRestore();
  });

  it('shows a historical version from the route, with its approval evidence and no approve action', async () => {
    nav.params = { id: 's1', version: '1' };
    setup(specDetail({ versions: [specVersion(2), specVersion(1, { approval, recording: recording({ state: 'recorded', jobStatus: 'merged', prUrl: 'https://github.com/o/r/pull/5' }) })] }));
    render(<SpecDetailView />);
    expect(await screen.findByRole('heading', { name: 'Version 1: Title 1' })).toBeInTheDocument();
    const evidence = screen.getByRole('region', { name: 'Approval evidence' });
    expect(evidence).toHaveTextContent('Ann (ann@example.com)');
    expect(evidence).toHaveTextContent('sha1');
    expect(screen.queryByRole('button', { name: /^Approve/ })).not.toBeInTheDocument();
    const rec = screen.getByRole('region', { name: 'Recording job' });
    expect(within(rec).getByRole('link', { name: 'Record spec dark-mode v1' })).toHaveAttribute('href', '/jobs/job1?project=p');
    expect(within(rec).getByText('Merged')).toBeInTheDocument();
    expect(within(rec).getByRole('link', { name: /Pull request/ })).toHaveAttribute('href', 'https://github.com/o/r/pull/5');
    expect(screen.getByText('Criterion 1')).toBeInTheDocument();
    expect(screen.getByText('This is the first version; there is nothing to compare with.')).toBeInTheDocument();
  });

  it('reports a version that does not exist', async () => {
    nav.params = { id: 's1', version: '9' };
    setup();
    render(<SpecDetailView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Version 9 does not exist.');
  });

  it('renders the body safely and drops unsafe links and recording PR urls', async () => {
    setup(specDetail({
      versions: [specVersion(2, {
        body: '## Goal\n\n<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1)) [ok](https://example.com)',
        recording: recording({ prUrl: 'javascript:alert(1)' }),
      })],
      currentVersion: 2,
    }));
    const { container } = render(<SpecDetailView />);
    await screen.findByRole('heading', { name: 'Version 2: Title 2' });
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'bad' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ok' })).toHaveAttribute('href', 'https://example.com');
    expect(screen.queryByRole('link', { name: /Pull request/ })).not.toBeInTheDocument();
  });

  it('diffs against the previous version by default and lets you pick another, escaping markup', async () => {
    setup(specDetail({ currentVersion: 3, versions: [specVersion(3, { body: 'three <b>x</b>' }), specVersion(2, { body: 'two' }), specVersion(1, { body: 'one' })] }));
    const { container } = render(<SpecDetailView />);
    const diff = await screen.findByRole('figure', { name: 'Changes from version 2 to 3' });
    expect(diff).toHaveTextContent('three <b>x</b>');
    expect(container.querySelector('figure b')).toBeNull();
    fireEvent.change(screen.getByLabelText('Compare with version'), { target: { value: '1' } });
    expect(await screen.findByRole('figure', { name: 'Changes from version 1 to 3' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Compare with version'), { target: { value: '' } });
    expect(screen.queryByRole('figure')).not.toBeInTheDocument();
  });

  it('shows the open-question reasons and disables Approve for an eligible-to-approve human', async () => {
    setup(specDetail({ versions: [specVersion(2, { eligibility: { eligible: false, reasons: ['Open question: which provider?'] } })] , currentVersion: 2 }));
    render(<SpecDetailView />);
    const approve = await screen.findByRole('button', { name: 'Approve version 2' });
    expect(approve).toBeDisabled();
    expect(screen.getAllByText('Open question: which provider?').length).toBeGreaterThan(0);
  });

  it('offers no Approve control when the API says the caller may not approve', async () => {
    setup(specDetail({ mayApprove: false, mayApproveReasons: ['API keys cannot approve.'] }));
    render(<SpecDetailView />);
    await screen.findByRole('heading', { name: 'Version 2: Title 2' });
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.getByText(/You cannot approve specs\. API keys cannot approve\./)).toBeInTheDocument();
  });

  it('does not offer to approve an older version of the spec', async () => {
    nav.params = { id: 's1', version: '1' };
    setup();
    render(<SpecDetailView />);
    const approve = await screen.findByRole('button', { name: 'Approve version 1' });
    expect(approve).toBeDisabled();
    expect(screen.getByText('Only the newest version can be approved.')).toBeInTheDocument();
  });

  it('approves exactly the visible version, once, and does not claim more', async () => {
    const get = setup();
    let release!: (d: SpecDetail) => void;
    const approve = vi.spyOn(api, 'approveSpec').mockReturnValue(new Promise((r) => (release = r)));
    render(<SpecDetailView />);
    const button = await screen.findByRole('button', { name: 'Approve version 2' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith('s1', 2);
    expect(await screen.findByRole('button', { name: 'Approving…' })).toBeDisabled();
    get.mockResolvedValue(specDetail({ status: 'approved', approvedVersion: 2, versions: [specVersion(2, { approval, recording: recording() }), specVersion(1)] }));
    release(specDetail());
    expect(await screen.findByRole('status')).toHaveTextContent('Version 2 approved');
    await waitFor(() => expect(screen.getByRole('region', { name: 'Approval evidence' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^Approve/ })).not.toBeInTheDocument();
  });

  it('keeps sending the version on screen when a newer one appears while polling', async () => {
    const get = setup();
    const approve = vi.spyOn(api, 'approveSpec').mockRejectedValue(new ApiError('x', 409, 'Expected version 2 but the spec is at 3.'));
    render(<SpecDetailView />);
    await screen.findByRole('button', { name: 'Approve version 2' });
    get.mockResolvedValue(specDetail({ currentVersion: 3, versions: [specVersion(3), specVersion(2), specVersion(1)] }));
    // a refresh (as polling does) reveals version 3 but the page stays on version 2
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await screen.findByText(/A newer version exists/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Version 2: Title 2' })).toBeInTheDocument();
    // v2 is no longer the newest, so it cannot be approved from here at all
    expect(screen.getByRole('button', { name: 'Approve version 2' })).toBeDisabled();
    expect(approve).not.toHaveBeenCalled();
  });

  it('explains a 409 and refreshes to the newest version on request', async () => {
    const get = setup();
    vi.spyOn(api, 'approveSpec').mockRejectedValue(new ApiError('x', 409, 'Expected version 2 but the spec is at 3.'));
    render(<SpecDetailView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve version 2' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('nothing was approved');
    expect(alert).toHaveTextContent('Expected version 2 but the spec is at 3.');
    expect(screen.queryByText(/approved\. A recording/)).not.toBeInTheDocument();
    get.mockResolvedValue(specDetail({ currentVersion: 3, versions: [specVersion(3), specVersion(2), specVersion(1)] }));
    fireEvent.click(within(alert).getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('heading', { name: 'Version 3: Title 3' })).toBeInTheDocument();
  });

  it('explains a 403 and does not leave the button stuck busy', async () => {
    setup();
    vi.spyOn(api, 'approveSpec').mockRejectedValue(new ApiError('x', 403, 'Only verified humans may approve.'));
    render(<SpecDetailView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve version 2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You are not allowed to approve this spec');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve version 2' })).toBeEnabled());
  });

  it('keeps showing the spec of the URL when another project is selected, and says so', async () => {
    nav.search = 'project=q';
    setup();
    render(<SpecDetailView />);
    expect(await screen.findByRole('status')).toHaveTextContent('belongs to another project');
    expect(screen.getByRole('link', { name: 'Back to the specs of the selected project' })).toHaveAttribute('href', '/specs?project=q');
    expect(screen.getByRole('link', { name: 'Specs' })).toHaveAttribute('href', '/specs?project=p');
  });

  it('shows the issue a spec came from and the intake status', async () => {
    setup(specDetail({ source: { kind: 'github_issue', url: 'https://github.com/o/web/issues/7', number: 7 } }));
    const { intakeItem } = await import('./intake.fixture');
    vi.spyOn(api, 'listIntake').mockResolvedValue([intakeItem({ specId: 's1', status: 'drafted' }), intakeItem({ id: 'x', specId: 'other', status: 'failed' })]);
    render(<SpecDetailView />);
    const link = await screen.findByRole('link', { name: 'From issue #7' });
    expect(link).toHaveAttribute('href', 'https://github.com/o/web/issues/7');
    expect(link).toHaveAttribute('target', '_blank');
    expect(await screen.findByText('Drafted')).toBeInTheDocument();
    expect(screen.queryByText('Failed')).toBeNull();
  });

  it('shows no issue link or intake status for a spec written by hand', async () => {
    setup();
    const intake = vi.spyOn(api, 'listIntake').mockResolvedValue([]);
    render(<SpecDetailView />);
    await screen.findByRole('heading', { name: 'Dark mode' });
    expect(screen.queryByText(/From issue/)).toBeNull();
    expect(intake).not.toHaveBeenCalled();
  });

  describe('archiving', () => {
    it('archives after confirming, and shows the pinned-feature refusal', async () => {
      const get = setup();
      const archive = vi.spyOn(api, 'archiveSpec').mockRejectedValueOnce(new ApiError('409', 409, 'Spec is pinned by feature "Plan" (f1) and cannot be archived'));
      render(<SpecDetailView />);
      fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
      expect(archive).not.toHaveBeenCalled();
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Archive' }));
      expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('pinned by feature "Plan"');

      archive.mockResolvedValueOnce(specDetail({ archivedAt: '2026-02-01T00:00:00.000Z' }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive' }));
      await waitFor(() => expect(archive).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(get.mock.calls.length).toBeGreaterThan(1);
    });

    it('offers no archive actions to someone who is not a verified human', async () => {
      setup(specDetail({ mayApprove: false }));
      render(<SpecDetailView />);
      await screen.findByRole('heading', { name: 'Dark mode' });
      expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    });

    it('shows the badge and Unarchive for an archived spec', async () => {
      setup(specDetail({ archivedAt: '2026-02-01T00:00:00.000Z' }));
      const unarchive = vi.spyOn(api, 'unarchiveSpec').mockResolvedValue(specDetail());
      render(<SpecDetailView />);
      expect(await screen.findByText('Archived', { selector: 'span' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
      await waitFor(() => expect(unarchive).toHaveBeenCalledWith('s1'));
    });
  });
});
