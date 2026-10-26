'use client';

import Link from 'next/link';
import { useCallback, useState, type FormEvent } from 'react';
import { FEATURE_STATUSES, api, type Feature, type FeatureStatus } from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { usePolling } from '@/lib/use-polling';
import { useProject, withProject } from '@/lib/use-project';
import { FeatureProgressBar, ReadyToCloseBadge } from './feature-progress';
import { NoProjects } from './no-projects';
import { StatusBadge } from './status-badge';
import { Button } from './ui/button';

const POLL_MS = 10_000;
const SELECT = 'h-9 rounded-md border border-input bg-card px-2 text-sm';
const INPUT = 'h-9 rounded-md border border-input bg-card px-2 text-sm';

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
        <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <h2 className="font-serif text-lg font-semibold">Features</h2>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <select aria-label="Status" className={SELECT} value={status} onChange={(e) => setStatus(e.target.value as FeatureStatus | '')}>
              <option value="">All statuses</option>
              {FEATURE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </header>
        {projects?.length === 0 && <NoProjects />}
        <form onSubmit={create} className="flex items-center gap-2 px-4 pt-3">
          <input aria-label="New feature title" placeholder="New feature title" className={`${INPUT} w-80`} value={title} onChange={(e) => setTitle(e.target.value)} />
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
            <li key={f.id} className="rounded-md border border-border bg-card p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={withProject(`/features/${f.id}`, projectId)} className="font-medium underline-offset-2 hover:underline">
                  {f.title}
                </Link>
                <StatusBadge kind="feature" status={f.status} />
                <ReadyToCloseBadge feature={f} />
              </div>
              <div className="mt-2">
                <FeatureProgressBar progress={f.progress} />
              </div>
            </li>
          ))}
        </ul>
    </>
  );
}
