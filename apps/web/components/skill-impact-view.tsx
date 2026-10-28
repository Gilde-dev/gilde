'use client';

import { useCallback, useState } from 'react';
import { SKILL_IMPACT_DAYS, api, type ImpactGroup, type SkillImpact, type SkillVersionImpact } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { Badge } from './ui/badge';
import { EmptyState } from './ui/empty-state';
import { Skeleton } from './ui/skeleton';

const POLL_MS = 60_000;
const SELECT = 'h-9 rounded-md border border-input bg-card px-2 text-sm';

export const IMPACT_NOTE =
  'These are descriptive comparisons of finished runs, not effects. Job difficulty and other changes differ between the groups, so a difference here does not show what a skill did.';

const pct = (r: number) => `${Math.round(r * 100)}%`;
const day = (iso: string) => iso.slice(0, 10);

type Counts = ImpactGroup['counts'];
const ROWS: { key: keyof Counts; label: string }[] = [
  { key: 'done', label: 'Done' },
  { key: 'partial', label: 'Partial' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'merged', label: 'Merged' },
  { key: 'rejectedOrParked', label: 'Rejected or parked' },
  { key: 'ciFailed', label: 'CI failed' },
];

function Cell({ group, value }: { group: ImpactGroup; value: keyof Counts }) {
  if (group.n === 0) return <>–</>;
  return <>{group.counts[value]}{group.rates ? ` (${pct(group.rates[value])})` : ''}</>;
}

function GroupHead({ title, group }: { title: string; group: ImpactGroup }) {
  return (
    <th scope="col" className="px-3 py-2 text-left font-medium">
      <div>{title}</div>
      <div className="flex items-center gap-2 font-normal text-muted-foreground">
        <span>n = {group.n}</span>
        {group.insufficient && <Badge variant="neutral">Not enough data</Badge>}
      </div>
    </th>
  );
}

function VersionTable({ version, name }: { version: SkillVersionImpact; name: string }) {
  const { with: w, without: wo } = version;
  return (
    <table aria-label={`${name} ${version.hash.slice(0, 8)} with and without`} className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">Finished runs</th>
          <GroupHead title="With this version" group={w} />
          <GroupHead title="Same repos, without the skill" group={wo} />
        </tr>
      </thead>
      <tbody>
        {ROWS.map((r) => (
          <tr key={r.key} className="border-b border-border-subtle">
            <th scope="row" className="px-3 py-1.5 text-left font-normal text-muted-foreground">{r.label}</th>
            <td className="px-3 py-1.5"><Cell group={w} value={r.key} /></td>
            <td className="px-3 py-1.5"><Cell group={wo} value={r.key} /></td>
          </tr>
        ))}
        <tr className="border-b border-border-subtle">
          <th scope="row" className="px-3 py-1.5 text-left font-normal text-muted-foreground">Average revision rounds</th>
          <td className="px-3 py-1.5">{w.avgRevisionRounds === null ? '–' : w.avgRevisionRounds.toFixed(2)}</td>
          <td className="px-3 py-1.5">{wo.avgRevisionRounds === null ? '–' : wo.avgRevisionRounds.toFixed(2)}</td>
        </tr>
        <tr>
          <th scope="row" className="px-3 py-1.5 text-left font-normal text-muted-foreground">Median attributed tokens</th>
          <td className="px-3 py-1.5">{w.medianTokens === null ? '–' : `${Math.round(w.medianTokens).toLocaleString('en')} (n = ${w.tokensN})`}</td>
          <td className="px-3 py-1.5">{wo.medianTokens === null ? '–' : `${Math.round(wo.medianTokens).toLocaleString('en')} (n = ${wo.tokensN})`}</td>
        </tr>
      </tbody>
    </table>
  );
}

function SkillSection({ skill }: { skill: SkillImpact['skills'][number] }) {
  return (
    <section aria-label={`Skill ${skill.name}`} className="rounded-lg border border-border bg-card p-4">
      <h3 className="font-mono text-md font-semibold">{skill.name}</h3>
      <table aria-label={`${skill.name} versions`} className="mt-2 w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th scope="col" className="px-3 py-1.5 font-medium">Version</th>
            <th scope="col" className="px-3 py-1.5 font-medium">First seen</th>
            <th scope="col" className="px-3 py-1.5 font-medium">Last seen</th>
            <th scope="col" className="px-3 py-1.5 font-medium">Source</th>
            <th scope="col" className="px-3 py-1.5 font-medium">Finished runs</th>
          </tr>
        </thead>
        <tbody>
          {skill.versions.map((v) => (
            <tr key={v.hash} className="border-b border-border-subtle">
              <td className="px-3 py-1.5 font-mono">{v.hash.slice(0, 8)}</td>
              <td className="px-3 py-1.5">{day(v.firstSeenAt)}</td>
              <td className="px-3 py-1.5">{day(v.lastSeenAt)}</td>
              <td className="px-3 py-1.5 text-muted-foreground">{v.managedBy ?? 'repo-owned'}</td>
              <td className="px-3 py-1.5">{v.with.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-4 space-y-4">
        {skill.versions.map((v) => (
          <div key={v.hash}>
            <h4 className="mb-1 text-sm font-semibold">
              Version <span className="font-mono">{v.hash.slice(0, 8)}</span>, first seen {day(v.firstSeenAt)}
            </h4>
            <VersionTable version={v} name={skill.name} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function SkillImpactView({ projectId }: { projectId: string }) {
  const [days, setDays] = useState<number>(30);
  const fetchImpact = useCallback(() => api.getSkillImpact(projectId, days), [projectId, days]);
  const impact = usePolling<SkillImpact>(fetchImpact, POLL_MS);

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">{IMPACT_NOTE}</p>
        <label className="ml-auto flex items-center gap-2 text-sm">
          Window
          <select className={SELECT} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {SKILL_IMPACT_DAYS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </label>
      </div>
      {impact.error && <p role="alert" className="text-sm text-danger">{impact.error.message}</p>}
      {!impact.data && !impact.error && <Skeleton className="h-32 w-full" />}
      {impact.data && (
        <>
          <p className="text-xs text-muted-foreground">
            Finished runs of the last {impact.data.days} days. A group with fewer than {impact.data.minRuns} finished runs shows
            &ldquo;Not enough data&rdquo; and no rates.
          </p>
          {impact.data.skills.length === 0 ? (
            <EmptyState title="No skill data yet" text="No finished runs with a recorded skill set in this window." />
          ) : (
            impact.data.skills.map((s) => <SkillSection key={s.name} skill={s} />)
          )}
        </>
      )}
    </div>
  );
}
