'use client';

import Link from 'next/link';
import { useCallback, useState, type FormEvent } from 'react';
import { FEATURE_STATUSES, api, type Feature, type FeatureStatus, type Job } from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { relativeTime } from '@/lib/time';
import { usePolling } from '@/lib/use-polling';
import { useProject, withProject } from '@/lib/use-project';
import { FeatureProgressBar, ReadyToCloseBadge } from './feature-progress';
import { NoProjects } from './no-projects';
import { StatusBadge } from './status-badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { PageHeader } from './ui/page-header';
import { Select } from './ui/select';

const POLL_MS = 10_000;

export function FeaturesView() {
  const [status, setStatus] = useState<FeatureStatus | ''>('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { projects, projectId } = useProject();

  const fetchFeatures = useCallback(
    () => (projectId ? api.listFeatures(projectId, status || undefined) : Promise.resolve([] as Feature[])),
    [projectId, status],
  );
  const features = usePolling(fetchFeatures, POLL_MS);
  const fetchRepoJobs = useCallback(() => (projectId ? api.listJobs(projectId) : Promise.resolve([] as Job[])), [projectId]);
  const jobs = usePolling(fetchRepoJobs, POLL_MS * 3);
  const repoCount = (featureId: string) => new Set(jobs.data?.filter((j) => j.featureId === featureId).map((j) => j.repoId)).size;

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    setSaving(true);
    setError(null);
    try {
      await api.createFeature(projectId, { title });
      setTitle('');
      await features.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
        <PageHeader
          className="px-4 pt-4"
          title="Features"
          description="Groups of jobs that ship together across a project's repos."
          actions={
            <Select aria-label="Status" className="w-auto" value={status} onChange={(e) => setStatus(e.target.value as FeatureStatus | '')}>
              <option value="">All statuses</option>
              {FEATURE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          }
        />
        {projects?.length === 0 && <NoProjects />}
        <form onSubmit={create} className="flex items-center gap-2 px-4 pt-3">
          <Input aria-label="New feature title" placeholder="New feature title" className="w-80" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Button type="submit" size="sm" disabled={saving || !projectId || title.trim().length < 3}>
            Add feature
          </Button>
        </form>
        {error && <p role="alert" className="px-4 pt-3 text-sm text-danger">{error}</p>}
        {features.error && <p role="alert" className="px-4 pt-3 text-sm text-danger">{features.error.message}</p>}
        {features.loading && !features.data && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
        {features.data?.length === 0 && <p className="p-4 text-sm text-muted-foreground">No features</p>}
        <ul className="space-y-2 p-4">
          {features.data?.map((f) => (
            <li key={f.id}>
            <Card className="p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={withProject(`/features/${f.id}`, projectId)} className="text-md font-semibold underline-offset-2 hover:underline">
                  {f.title}
                </Link>
                <StatusBadge kind="feature" status={f.status} />
                <ReadyToCloseBadge feature={f} />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                <FeatureProgressBar progress={f.progress} />
                <span className="text-sm text-muted-foreground">
                  {jobs.data ? `${repoCount(f.id)} ${repoCount(f.id) === 1 ? 'repo' : 'repos'}` : '… repos'}
                </span>
                <span className="text-sm text-muted-foreground">Updated {relativeTime(f.updatedAt)}</span>
              </div>
            </Card>
            </li>
          ))}
        </ul>
    </>
  );
}
