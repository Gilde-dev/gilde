'use client';

import { FileText } from 'lucide-react';
import Link from 'next/link';
import { useCallback } from 'react';
import { api, type Repo, type Spec } from '@/lib/api';
import { relativeTime } from '@/lib/time';
import { usePolling } from '@/lib/use-polling';
import { useProject, withProject } from '@/lib/use-project';
import { NoProjects } from './no-projects';
import { SpecStatusBadge } from './spec-detail';
import { Card } from './ui/card';
import { EmptyState } from './ui/empty-state';
import { PageHeader } from './ui/page-header';

const POLL_MS = 10_000;

export function SpecsView() {
  const { projects, projectId } = useProject();
  const fetchSpecs = useCallback(() => (projectId ? api.listSpecs(projectId) : Promise.resolve([] as Spec[])), [projectId]);
  const specs = usePolling(fetchSpecs, POLL_MS);
  const fetchRepos = useCallback(() => (projectId ? api.listRepos(projectId) : Promise.resolve([] as Repo[])), [projectId]);
  const repos = usePolling(fetchRepos, POLL_MS * 6);
  const repoName = (id: string) => repos.data?.find((r) => r.id === id)?.fullName;

  return (
    <>
      <PageHeader
        className="px-4 pt-4"
        title="Specs"
        description="Versioned documents the co-pilot drafts and a verified human approves."
      />
      {projects?.length === 0 && <NoProjects />}
      {specs.error && <p role="alert" className="px-4 pt-3 text-sm text-danger">{specs.error.message}</p>}
      {specs.loading && !specs.data && !specs.error && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
      {specs.data?.length === 0 && (
        <div className="p-4">
          <EmptyState icon={FileText} title="No specs" text="Ask the co-pilot to draft a spec for a repo of this project." />
        </div>
      )}
      <ul className="space-y-2 p-4">
        {specs.data?.map((s) => (
          <li key={s.id}>
            <Card className="p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={withProject(`/specs/${s.id}`, projectId)} className="text-md font-semibold underline-offset-2 hover:underline">
                  {s.title}
                </Link>
                <SpecStatusBadge spec={s} />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span className="font-mono">{repoName(s.repoId) ?? (repos.data ? 'unknown repo' : '…')}</span>
                <span className="font-mono">{s.slug}</span>
                <span>Current v{s.currentVersion}</span>
                <span>{s.approvedVersion === null ? 'Never approved' : `Approved v${s.approvedVersion}`}</span>
                <span>Updated {relativeTime(s.updatedAt)}</span>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
