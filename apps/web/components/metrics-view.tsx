'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type Metrics } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { useProject } from '@/lib/use-project';
import { BudgetSection } from './budget-section';
import { NoProjects } from './no-projects';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { StatCard } from './ui/stat-card';
import { UsageSection } from './usage-section';

const POLL_MS = 30_000;
const DAY_OPTIONS = [7, 30, 90];

const percent = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);

export function formatMinutes(m: number | null): string {
  if (m === null) return '–';
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export function MetricsView() {
  const [repoId, setRepoId] = useState('');
  const [days, setDays] = useState(30);

  const { projects, projectId } = useProject();
  // The repo filter belongs to one project.
  useEffect(() => setRepoId(''), [projectId]);
  const fetchRepos = useCallback(() => (projectId ? api.listRepos(projectId) : Promise.resolve([])), [projectId]);
  const repos = usePolling(fetchRepos, 60_000);
  const fetchMetrics = useCallback(
    () => (projectId ? api.getMetrics({ projectId, repoId: repoId || undefined, days }) : Promise.resolve(null)),
    [projectId, repoId, days],
  );
  const metrics = usePolling(fetchMetrics, POLL_MS);

  return (
    <>
        <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <h2 className="font-serif text-lg font-semibold">Factory metrics</h2>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <select
              aria-label="Repo"
              className="h-9 rounded-md border border-input bg-card px-2 text-sm"
              value={repoId}
              disabled={!projectId}
              onChange={(e) => setRepoId(e.target.value)}
            >
              <option value="">All repos</option>
              {repos.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName}
                </option>
              ))}
            </select>
            <div role="group" aria-label="Period" className="flex gap-1">
              {DAY_OPTIONS.map((d) => (
                <Button
                  key={d}
                  size="sm"
                  variant={d === days ? 'primary' : 'outline'}
                  aria-pressed={d === days}
                  onClick={() => setDays(d)}
                >
                  {d}d
                </Button>
              ))}
            </div>
          </div>
        </header>
        {projects?.length === 0 && <NoProjects />}
        {metrics.error && <p className="p-4 text-sm text-danger">{metrics.error.message}</p>}
        {metrics.loading && !metrics.data && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
        {metrics.data && <MetricsBody metrics={metrics.data} />}
        {projectId && <BudgetSection projectId={projectId} />}
        {projectId && <ScoutSection projectId={projectId} />}
        <UsageSection days={days} projectId={projectId} projectName={projects?.find((p) => p.id === projectId)?.name} />
    </>
  );
}

/**
 * Verkenner, the scout, for the selected project. Independent of the period and repo filters above: suggestions count
 * from Monday 00:00 UTC of the current week, and the last wake is the actual most recent one. Shown while the scout is off.
 */
export function ScoutSection({ projectId }: { projectId: string }) {
  const fetchScout = useCallback(() => api.scoutActivity(projectId), [projectId]);
  const scout = usePolling(fetchScout, POLL_MS);
  const a = scout.data;
  const failed = a === undefined && scout.error !== null;
  const value = <T,>(show: (activity: NonNullable<typeof a>) => T) => (failed ? '–' : a ? show(a) : '…');
  const hint = failed ? 'Could not load' : a === undefined ? 'Loading' : undefined;
  return (
    <section aria-label="Verkenner" className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-md font-semibold">Verkenner</h3>
        {a && <Badge variant={a.enabled ? 'success' : 'neutral'}>{a.enabled ? 'On' : 'Off'}</Badge>}
        <span className="text-sm text-muted-foreground">This project · current week since Monday {a?.weekStart ?? '…'} (UTC)</span>
      </div>
      {failed && (
        <p role="alert" className="text-sm text-danger">
          {scout.error!.message}
        </p>
      )}
      {a?.disabledReason && (
        <p role="status" className="text-sm text-warning">
          Verkenner disabled: {a.disabledReason}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatCard label="Status" value={value((x) => (x.enabled ? 'On' : 'Off'))} hint={hint ?? (a?.enabled ? a.model ?? undefined : 'Not running; history stays visible')} />
        <StatCard label="Suggestions this week" value={value((x) => x.suggestionsThisWeek)} hint={hint} />
        <StatCard label="Last wake" value={value((x) => (x.lastWakeAt ? new Date(x.lastWakeAt).toLocaleString() : 'Never'))} hint={hint} />
      </div>
    </section>
  );
}

export function MetricsBody({ metrics }: { metrics: Metrics }) {
  if (metrics.jobs.total === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No jobs in the last {metrics.days} days.</p>;
  }
  return (
    <div className="space-y-6 p-4">
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile label="Merge rate" value={percent(metrics.mergeRate)} />
        <Tile label="First-pass rate" value={percent(metrics.firstPassRate)} />
        <Tile label="Avg attempts" value={metrics.avgAttempts === null ? '–' : metrics.avgAttempts.toFixed(1)} />
        <Tile label="Median time to merge" value={formatMinutes(metrics.timeToMerge.median)} />
        <Tile label="p90 time to merge" value={formatMinutes(metrics.timeToMerge.p90)} />
        <Tile label="Gate failures" value={String(metrics.runs.gateFailures)} />
      </section>
      <DailyChart daily={metrics.daily} />
      <div className="grid gap-6 md:grid-cols-2">
        <Breakdown title="Run outcomes" counts={metrics.runs.byOutcome} />
        <Breakdown title="CI conclusions" counts={metrics.runs.byCiConclusion} />
      </div>
      <InstructionsTable rows={metrics.byInstructionsVersion} />
    </div>
  );
}

function InstructionsTable({ rows }: { rows: Metrics['byInstructionsVersion'] }) {
  return (
    <section aria-label="By instructions version">
      <h3 className="mb-2 text-sm font-semibold">By instructions version</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-1 font-normal">Version</th>
              <th className="py-1 font-normal">Runs</th>
              <th className="py-1 font-normal">Merged jobs</th>
              <th className="py-1 font-normal">First-pass rate</th>
              <th className="py-1 font-normal">Avg attempts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.version} className="border-t border-border">
                <td className="py-1 font-mono">{r.version}</td>
                <td className="py-1">{r.runs}</td>
                <td className="py-1">{r.mergedJobs}</td>
                <td className="py-1">{percent(r.firstPassRate)}</td>
                <td className="py-1">{r.avgAttempts === null ? '–' : r.avgAttempts.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}

const SERIES = [
  { key: 'created', label: 'Created', color: 'bg-info' },
  { key: 'merged', label: 'Merged', color: 'bg-success' },
  { key: 'parked', label: 'Parked', color: 'bg-warning' },
] as const;

function DailyChart({ daily }: { daily: Metrics['daily'] }) {
  const max = Math.max(1, ...daily.flatMap((d) => [d.created, d.merged, d.parked]));
  return (
    <section aria-label="Daily activity">
      <div className="mb-2 flex items-center gap-4">
        <h3 className="text-sm font-semibold">Daily activity</h3>
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className={`inline-block h-2 w-2 rounded-sm ${s.color}`} />
            {s.label}
          </span>
        ))}
      </div>
      <div className="flex h-40 items-end gap-px" role="img" aria-label="Jobs created, merged and parked per day">
        {daily.map((d) => (
          <div
            key={d.date}
            className="flex h-full min-w-0 flex-1 items-end justify-center gap-px"
            title={`${d.date}: ${d.created} created, ${d.merged} merged, ${d.parked} parked`}
          >
            {SERIES.map((s) => (
              <div key={s.key} className={`w-full max-w-2 ${s.color}`} style={{ height: `${(d[s.key] / max) * 100}%` }} />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{daily[0]?.date}</span>
        <span>{daily[daily.length - 1]?.date}</span>
      </div>
    </section>
  );
}

function Breakdown({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  const total = entries.reduce((n, [, c]) => n + c, 0);
  return (
    <section aria-label={title}>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <ul className="space-y-1">
          {entries.map(([name, n]) => (
            <li key={name} className="text-sm">
              <div className="flex justify-between">
                <span>{name}</span>
                <span className="text-muted-foreground">{n}</span>
              </div>
              <div className="h-1.5 rounded bg-muted">
                <div className="h-full rounded bg-info" style={{ width: `${(n / total) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
