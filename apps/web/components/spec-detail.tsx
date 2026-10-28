'use client';

import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type Repo, type Spec, type SpecDetail, type SpecRecording, type SpecVersion } from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { safeUrl } from '@/lib/safe-url';
import { relativeTime } from '@/lib/time';
import { usePolling } from '@/lib/use-polling';
import { useProject, withProject } from '@/lib/use-project';
import { CopilotPageContext } from './copilot-provider';
import { SafeMarkdown } from './safe-markdown';
import { StatusBadge } from './status-badge';
import { TextDiffView } from './text-diff-view';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Icon } from './ui/icon';
import { PageHeader } from './ui/page-header';
import { Select } from './ui/select';

const POLL_MS = 5000;

/** A draft is neutral; an approved spec whose newest version is not the approved one is still approved, but says it moved on. */
export function SpecStatusBadge({ spec }: { spec: Pick<Spec, 'status' | 'approvedVersion' | 'currentVersion'> }) {
  if (spec.status === 'approved') return <Badge variant="success">Approved</Badge>;
  return <Badge variant="neutral">{spec.approvedVersion === null ? 'Draft' : `Draft · v${spec.approvedVersion} approved`}</Badge>;
}

const RECORDING_LABEL: Record<SpecRecording['state'], string> = {
  triage: 'Recording waiting in triage',
  queued: 'Recording queued',
  in_flight: 'Recording in progress',
  recorded: 'Recorded',
  failed: 'Recording failed',
  superseded: 'Recording superseded',
};

/** What a failed approval means for the user, and whether the visible data is out of date. */
export function approveErrorText(e: unknown): { message: string; stale: boolean } {
  const detail = errorText(e);
  if (e instanceof ApiError && e.status === 403) {
    return { message: `You are not allowed to approve this spec: only a verified human signed in interactively can. ${detail}`, stale: true };
  }
  if (e instanceof ApiError && e.status === 409) {
    return { message: `This spec changed since you opened it, so nothing was approved. ${detail} Refresh to see the latest version.`, stale: true };
  }
  if (e instanceof ApiError && e.status === 422) return { message: `This version cannot be approved. ${detail}`, stale: true };
  return { message: detail, stale: false };
}

function RecordingInfo({ recording, projectId }: { recording: SpecRecording; projectId: string | null }) {
  const pr = safeUrl(recording.prUrl);
  return (
    <section aria-label="Recording job" className="space-y-1 text-sm">
      <h4 className="font-semibold">Recording</h4>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={withProject(`/jobs/${recording.jobId}`, projectId)} className="underline">
          {recording.jobTitle}
        </Link>
        <StatusBadge status={recording.jobStatus} mergedBlocked={recording.mergedWithoutWork} />
        <span className="text-muted-foreground">{RECORDING_LABEL[recording.state]}</span>
        {pr && (
          <a href={pr} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">
            Pull request <Icon icon={ExternalLink} size={14} />
          </a>
        )}
      </div>
      {recording.dependsOnJobId && (
        <p className="text-muted-foreground">
          Waits for an earlier recording:{' '}
          <Link href={withProject(`/jobs/${recording.dependsOnJobId}`, projectId)} className="underline">
            job {recording.dependsOnJobId.slice(0, 8)}
          </Link>
        </p>
      )}
    </section>
  );
}

function VersionPanel({
  spec,
  version,
  projectId,
  onApproved,
  onReload,
  staleNotice,
}: {
  spec: SpecDetail;
  version: SpecVersion;
  projectId: string | null;
  onApproved: () => Promise<void>;
  /** Refresh and move to the newest version. */
  onReload: () => Promise<void>;
  staleNotice: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<{ message: string; stale: boolean } | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const isCurrent = version.version === spec.currentVersion;
  const older = spec.versions.filter((v) => v.version < version.version);
  const [compareTo, setCompareTo] = useState<number | null | undefined>(undefined);
  const compareVersion = compareTo === undefined ? older[0] : older.find((v) => v.version === compareTo);

  // The approve call carries exactly the version this panel shows: the number is read from the rendered version, not from the polled spec.
  async function approve() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api.approveSpec(spec.id, version.version);
      setDone(version.version);
    } catch (e) {
      setError(approveErrorText(e));
    } finally {
      try {
        await onApproved();
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }

  const reasons = !version.eligibility.eligible ? version.eligibility.reasons : [];
  const disabledReasons = [...(isCurrent ? [] : ['Only the newest version can be approved.']), ...reasons];
  const approved = version.approval !== null;
  const canShowApprove = spec.mayApprove && !approved;

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-md font-semibold">
          Version {version.version}: {version.title}
        </h3>
        {approved ? <Badge variant="success">Approved</Badge> : <Badge variant="neutral">Not approved</Badge>}
        {isCurrent && <Badge variant="accent">Newest</Badge>}
        <span className="text-sm text-muted-foreground">Saved {relativeTime(version.createdAt)}</span>
      </div>
      {staleNotice && (
        <p role="status" className="text-sm text-warning">
          A newer version exists. This page keeps showing version {version.version} until you open the newest one.
        </p>
      )}

      {version.approval ? (
        <section aria-label="Approval evidence" className="text-sm">
          <h4 className="font-semibold">Approval evidence</h4>
          <p>
            Approved by {version.approval.approvedByName} ({version.approval.approvedByEmail}) {relativeTime(version.approval.approvedAt)} ·{' '}
            <span className="font-mono">{version.approval.approvedAt}</span>
          </p>
          <p className="text-muted-foreground">
            Approval <span className="font-mono">{version.approval.id}</span> · body SHA-256 <span className="font-mono break-all">{version.bodySha256}</span>
          </p>
        </section>
      ) : reasons.length > 0 ? (
        <section aria-label="Eligibility" className="text-sm">
          <h4 className="font-semibold">Cannot be approved yet</h4>
          <ul className="list-disc pl-5 text-warning">
            {reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">Not approved yet. Saving a draft never approves it.</p>
      )}

      {version.recording && <RecordingInfo recording={version.recording} projectId={projectId} />}

      {canShowApprove && (
        <div className="space-y-2">
          <Button size="sm" disabled={busy || disabledReasons.length > 0} onClick={() => void approve()}>
            {busy ? 'Approving…' : `Approve version ${version.version}`}
          </Button>
          {disabledReasons.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-muted-foreground">
              {disabledReasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {!spec.mayApprove && !approved && (
        <p className="text-sm text-muted-foreground">
          You cannot approve specs.{spec.mayApproveReasons.length > 0 && ` ${spec.mayApproveReasons.join(' ')}`}
        </p>
      )}
      {done === version.version && (
        <p role="status" className="text-sm text-success">
          Version {version.version} approved. A recording job was created in triage.
        </p>
      )}
      {error && (
        <div role="alert" className="space-y-2 text-sm text-danger">
          <p>{error.message}</p>
          <Button size="sm" variant="outline" onClick={() => void onReload()}>
            Refresh
          </Button>
        </div>
      )}

      <section aria-label="Acceptance criteria" className="text-sm">
        <h4 className="font-semibold">Acceptance criteria</h4>
        {version.criteria.length === 0 ? (
          <p className="text-muted-foreground">No acceptance criteria</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {version.criteria.map((c) => (
              <li key={c.id}>
                <span className="font-mono">{c.id}</span> {c.text}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Body">
        <h4 className="text-sm font-semibold">Body</h4>
        <SafeMarkdown source={version.body} />
      </section>

      <section aria-label="Compare versions" className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold">Compare with</h4>
          <Select
            aria-label="Compare with version"
            className="w-auto"
            value={compareVersion ? String(compareVersion.version) : ''}
            disabled={older.length === 0}
            onChange={(e) => setCompareTo(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">No comparison</option>
            {older.map((v) => (
              <option key={v.id} value={v.version}>
                Version {v.version}
              </option>
            ))}
          </Select>
        </div>
        {older.length === 0 && <p className="text-sm text-muted-foreground">This is the first version; there is nothing to compare with.</p>}
        {compareVersion && (
          <TextDiffView before={compareVersion.body} after={version.body} label={`Changes from version ${compareVersion.version} to ${version.version}`} />
        )}
      </section>
    </Card>
  );
}

/** A spec with its version history; `/specs/:id/versions/:version` selects a historical version. */
export function SpecDetailView() {
  const params = useParams<{ id: string; version?: string }>();
  const { id } = params;
  const routeVersion = params.version ? Number(params.version) : null;
  const { projects, projectId } = useProject();
  const fetchSpec = useCallback(() => api.getSpec(id), [id]);
  const spec = usePolling(fetchSpec, POLL_MS);
  const s = spec.data;
  const fetchRepos = useCallback(() => (s ? api.listRepos(s.projectId) : Promise.resolve([] as Repo[])), [s?.projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const repos = usePolling(fetchRepos, 60_000);

  // The version on screen is chosen once and kept: polling may reveal a newer one, but never swaps what the user is looking at.
  const [pinned, setPinned] = useState<{ id: string; version: number } | null>(null);
  useEffect(() => {
    if (s && routeVersion === null && (!pinned || pinned.id !== s.id)) setPinned({ id: s.id, version: s.currentVersion });
  }, [s, routeVersion, pinned]);
  const shownNumber = routeVersion ?? (pinned && pinned.id === id ? pinned.version : null);
  const version = s && shownNumber !== null ? s.versions.find((v) => v.version === shownNumber) : undefined;
  const repoName = s ? repos.data?.find((r) => r.id === s.repoId)?.fullName : undefined;
  const otherProject = !!s && !!projectId && projects !== undefined && s.projectId !== projectId;
  const listProject = s?.projectId ?? projectId;

  const reload = useCallback(async () => {
    await spec.refresh();
    setPinned(null);
  }, [spec]);

  return (
    <>
      <CopilotPageContext description="The spec page open in the Gilde UI" value={{ specId: id }} />
      {spec.error && !s && <p role="alert" className="p-4 text-sm text-danger">{spec.error.message}</p>}
      {spec.loading && !s && !spec.error && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
      {s && (
        <>
          <PageHeader
            className="px-4 pt-4"
            title={s.title}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <Link href={withProject('/specs', listProject)} className="underline">
                  Specs
                </Link>
                <SpecStatusBadge spec={s} />
                <span className="font-mono">{repoName ?? '…'}</span>
                <span className="font-mono">{s.slug}</span>
              </span>
            }
          />
          {otherProject && (
            <p role="status" className="px-4 pt-3 text-sm text-warning">
              This spec belongs to another project than the one selected.{' '}
              <Link href={withProject('/specs', projectId)} className="underline">
                Back to the specs of the selected project
              </Link>
            </p>
          )}
          {spec.error && <p role="alert" className="px-4 pt-3 text-sm text-danger">{spec.error.message}</p>}
          <div className="space-y-4 p-4">
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <div>
                <dt className="inline text-muted-foreground">Newest version </dt>
                <dd className="inline">v{s.currentVersion}</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">Approved version </dt>
                <dd className="inline">{s.approvedVersion === null ? 'none' : `v${s.approvedVersion}`}</dd>
              </div>
            </dl>
            <nav aria-label="Versions">
              <ul className="flex flex-wrap gap-2">
                {s.versions.map((v) => (
                  <li key={v.id}>
                    <Link
                      href={withProject(`/specs/${s.id}/versions/${v.version}`, listProject)}
                      aria-current={v.version === shownNumber ? 'page' : undefined}
                      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-sm hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-semibold"
                    >
                      v{v.version}
                      {v.approval && <span className="text-success">approved</span>}
                      {!v.approval && !v.eligibility.eligible && <span className="text-warning">blocked</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            {version ? (
              <VersionPanel
                key={`${s.id}:${version.version}`}
                spec={s}
                version={version}
                projectId={listProject}
                onApproved={spec.refresh}
                onReload={reload}
                staleNotice={version.version !== s.currentVersion && routeVersion === null}
              />
            ) : (
              shownNumber !== null && <p role="alert" className="text-sm text-danger">Version {shownNumber} does not exist.</p>
            )}
          </div>
        </>
      )}
    </>
  );
}
