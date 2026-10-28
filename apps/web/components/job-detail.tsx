'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { api, type AgentTotals, type Feedback, type JobDetail, type PromptTrimmed, type Revision, type Run, type RunContext, type RunExecutor } from '@/lib/api';
import { AgentUsageSummary } from './agent-usage';
import { errorText } from '@/lib/job-actions';
import { relativeTime } from '@/lib/time';
import { usePolling } from '@/lib/use-polling';
import { withProject } from '@/lib/use-project';
import { CopilotPageContext } from './copilot-provider';
import { JobActions } from './job-actions';
import { StatusBadge } from './status-badge';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { EmptyState } from './ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

const POLL_MS = 5000;

function exact(iso: string): string {
  return new Date(iso).toLocaleString('en');
}

function Time({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={exact(iso)}>
      {relativeTime(iso)}
    </time>
  );
}

function duration(run: Run): string | null {
  const start = run.firedAt ?? run.createdAt;
  if (!run.finishedAt) return null;
  const s = Math.max(0, Math.round((new Date(run.finishedAt).getTime() - new Date(start).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export interface TimelineEvent {
  at: string;
  label: string;
}

/** Events derived from the job, its runs, feedback and revisions; newest first. */
export function buildTimeline(job: JobDetail, revisions: Revision[]): TimelineEvent[] {
  const events: TimelineEvent[] = [{ at: job.createdAt, label: `Created by ${job.createdBy?.name ?? 'System'}` }];
  if (job.queuedAt) events.push({ at: job.queuedAt, label: 'Queued' });
  for (const run of job.runs) {
    events.push({ at: run.firedAt ?? run.createdAt, label: `Attempt ${run.attempt} started` });
    if (run.finishedAt) events.push({ at: run.finishedAt, label: `Attempt ${run.attempt} finished (${run.status.replace(/_/g, ' ')})` });
  }
  const reviews = job.feedback.filter((f) => f.kind === 'review');
  const firstFeedback = job.feedback.reduce<string | null>((min, f) => (!min || f.createdAt < min ? f.createdAt : min), null);
  if (job.prNumber) {
    // The PR is opened by the first run that reports it; fall back to the earliest known activity after the first run.
    const opened = job.runs.find((r) => r.finishedAt)?.finishedAt ?? firstFeedback;
    if (opened) events.push({ at: opened, label: `PR #${job.prNumber} opened` });
  }
  for (const f of reviews) events.push({ at: f.createdAt, label: `Review by ${f.author}${f.state ? ` (${f.state.toLowerCase().replace(/_/g, ' ')})` : ''}` });
  for (const r of revisions) {
    events.push({ at: r.createdAt, label: `Revision proposed: ${r.reason}` });
    if (r.decidedAt) events.push({ at: r.decidedAt, label: `Revision ${r.status}` });
  }
  if (job.status === 'merged') events.push({ at: job.updatedAt, label: 'Merged' });
  if (job.status === 'cancelled') events.push({ at: job.updatedAt, label: 'Cancelled' });
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-md font-semibold">{title}</h3>
      <div className="mt-1">{children}</div>
    </section>
  );
}

function Overview({ job, dependents, projectId }: { job: JobDetail; dependents: { id: string; title: string; status: JobDetail['status'] }[]; projectId: string }) {
  const titles = new Map(job.blockedBy.map((b) => [b.id, b]));
  return (
    <div className="space-y-5">
      <Section title="Task">
        <p className="whitespace-pre-wrap text-sm">{job.task}</p>
      </Section>
      {job.acceptanceCriteria.length > 0 && (
        <Section title="Acceptance criteria">
          <ul className="space-y-1 text-sm">
            {job.acceptanceCriteria.map((c, i) => (
              <li key={i} className="flex gap-2">
                <input type="checkbox" disabled aria-label="criterion" className="mt-1" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {job.status === 'queued' && job.waitingReason && (
        <Section title="Waiting">
          <p className="text-sm">{job.waitingReason}</p>
        </Section>
      )}
      {job.lastReason && (
        <Section title="Last reason">
          <p className="whitespace-pre-wrap text-sm">{job.lastReason}</p>
        </Section>
      )}
      <Section title="Dependencies">
        {job.dependsOn.length === 0 ? (
          <p className="text-sm text-muted-foreground">None</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {job.dependsOn.map((depId) => {
              const dep = titles.get(depId);
              return (
                <li key={depId} className="flex items-center gap-2">
                  <Link href={withProject(`/jobs/${depId}`, projectId)} className="underline">
                    {dep?.title ?? depId}
                  </Link>
                  <StatusBadge status={dep?.status ?? 'merged'} />
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      {dependents.length > 0 && (
        <Section title="Dependents">
          <ul className="space-y-1 text-sm">
            {dependents.map((d) => (
              <li key={d.id} className="flex items-center gap-2">
                <Link href={withProject(`/jobs/${d.id}`, projectId)} className="underline">
                  {d.title}
                </Link>
                <StatusBadge status={d.status} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

const shortHash = (h: string | null) => (h ? h.slice(0, 8) : 'none');

/** What the agent had in this run; old runs and failed captures say so instead of showing zeros. */
export function RunContextSummary({ context, error }: { context: RunContext | null; error: string | null }) {
  if (!context) {
    return (
      <p className="text-muted-foreground">
        Context: not recorded{error && <> ({error})</>}
      </p>
    );
  }
  const managed = context.skills.filter((s) => s.managedBy !== null);
  const own = context.skills.filter((s) => s.managedBy === null);
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground">
        Context: gildeboek {context.gildeboekVersion ?? 'unknown'} · {context.skills.length} {context.skills.length === 1 ? 'skill' : 'skills'} · AGENTS.md{' '}
        <span className="font-mono">{shortHash(context.agentsMdHash)}</span>
      </p>
      {context.skills.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Skills ({managed.length} managed, {own.length} repo-owned)</summary>
          <ul className="mt-1 space-y-0.5 text-xs">
            {[...managed, ...own].map((s) => (
              <li key={s.name}>
                {s.name} <span className="font-mono text-muted-foreground">{shortHash(s.hash)}</span>{' '}
                <span className="text-muted-foreground">{s.managedBy === null ? 'repo-owned' : `managed (${s.managedBy})`}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function RunCard({ run, prUrl, prNumber }: { run: Run & { agentUsage?: AgentTotals; executor?: RunExecutor | null }; prUrl: string | null; prNumber: number | null }) {
  const dur = duration(run);
  return (
    <Card>
      <CardContent className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Attempt {run.attempt}</span>
          <Badge variant="neutral">{run.status}</Badge>
          {run.ciConclusion && <Badge variant={run.ciConclusion === 'success' ? 'success' : 'danger'}>CI {run.ciConclusion}</Badge>}
          {run.result && (
            <Badge variant={run.result.outcome === 'done' ? 'success' : run.result.outcome === 'blocked' ? 'danger' : 'warning'}>
              {run.result.outcome}
            </Badge>
          )}
          {run.sessionUrl && (
            <a href={run.sessionUrl} target="_blank" rel="noreferrer" className="ml-auto underline">
              Session
            </a>
          )}
        </div>
        <p className="text-muted-foreground">
          Started <Time iso={run.firedAt ?? run.createdAt} />
          {run.finishedAt && (
            <>
              {' · finished '}
              <Time iso={run.finishedAt} />
            </>
          )}
          {dur && ` · took ${dur}`}
          {run.executor && ` · on ${run.executor.name} (${run.executor.ownerName})`}
          {prUrl && (
            <>
              {' · '}
              <a href={prUrl} target="_blank" rel="noreferrer" className="underline">
                PR #{prNumber}
              </a>
            </>
          )}
        </p>
        {run.result && <p>{run.result.summary}</p>}
        {run.error && <p className="text-danger">{run.error}</p>}
        <RunContextSummary context={run.context} error={run.contextError} />
        {run.agentUsage && <AgentUsageSummary t={run.agentUsage} label={`Attempt ${run.attempt} usage (Claude Code)`} />}
        {run.retro && (
          <details>
            <summary className="cursor-pointer text-muted-foreground">Retro</summary>
            <pre className="mt-1 whitespace-pre-wrap font-sans text-xs">{run.retro}</pre>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function changes(r: Revision): string[] {
  return [r.title && 'title', r.task && 'task', r.acceptanceCriteria && 'criteria', r.dependsOn && 'dependencies'].filter(Boolean) as string[];
}

function Revisions({ revisions, onChanged }: { revisions: Revision[]; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(r: Revision, action: 'accept' | 'reject') {
    setBusy(r.id);
    setError(null);
    try {
      await (action === 'accept' ? api.acceptRevision(r.id) : api.rejectRevision(r.id));
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (revisions.length === 0) return <p className="text-sm text-muted-foreground">No revisions</p>;
  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {revisions.map((r) => (
        <Card key={r.id}>
          <CardContent className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={r.status === 'accepted' ? 'success' : r.status === 'rejected' ? 'danger' : 'warning'}>
                {r.status === 'accepted' && r.revision ? `accepted #${r.revision}` : r.status}
              </Badge>
              <span className="text-muted-foreground">
                changes {changes(r).join(', ') || 'nothing'} · <Time iso={r.createdAt} />
              </span>
              {r.pr && (
                <a href={r.pr.url} target="_blank" rel="noreferrer" className="underline">
                  PR #{r.pr.number}
                </a>
              )}
            </div>
            <p>{r.reason}</p>
            {r.title && <p><span className="font-medium">Title: </span>{r.title}</p>}
            {r.task && <p className="whitespace-pre-wrap"><span className="font-medium">Task: </span>{r.task}</p>}
            {r.acceptanceCriteria && (
              <div>
                <span className="font-medium">Acceptance criteria:</span>
                <ul className="list-disc pl-5">
                  {r.acceptanceCriteria.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
            {r.status === 'proposed' && (
              <div className="flex gap-2">
                <Button size="sm" disabled={busy === r.id} onClick={() => void decide(r, 'accept')}>
                  Accept
                </Button>
                <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => void decide(r, 'reject')}>
                  Reject
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function FeedbackList({ feedback }: { feedback: Feedback[] }) {
  if (feedback.length === 0) return <p className="text-sm text-muted-foreground">No feedback yet</p>;
  const reviews = feedback.filter((f) => f.kind === 'review');
  const reviewIds = new Set(reviews.map((r) => r.reviewId ?? r.githubId));
  const comments = feedback.filter((f) => f.kind !== 'review');
  const byReview = (id: string) => comments.filter((c) => c.reviewId === id);
  const loose = comments.filter((c) => !c.reviewId || !reviewIds.has(c.reviewId));
  const item = (f: Feedback) => (
    <li key={f.id} className="rounded-md border border-border p-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{f.author}</span>
        {f.state && <Badge variant="neutral">{f.state.toLowerCase().replace(/_/g, ' ')}</Badge>}
        {f.path && <code className="font-mono">{f.path}{f.line ? `:${f.line}` : ''}</code>}
        <Time iso={f.createdAt} />
        <a href={f.url} target="_blank" rel="noreferrer" className="ml-auto underline">
          Open
        </a>
      </div>
      {f.body && <p className="mt-1 whitespace-pre-wrap text-sm">{f.body}</p>}
    </li>
  );
  return (
    <div className="space-y-4">
      {reviews.map((r) => (
        <ul key={r.id} className="space-y-2">
          {item(r)}
          <li>
            <ul className="ml-4 space-y-2">{byReview(r.reviewId ?? r.githubId).map(item)}</ul>
          </li>
        </ul>
      ))}
      {loose.length > 0 && (
        <div>
          <h4 className="text-sm font-medium">Comments</h4>
          <ul className="mt-1 space-y-2">{loose.map(item)}</ul>
        </div>
      )}
    </div>
  );
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** One line per reduction; empty when the whole context fits. */
export function describeTrimmed(t: PromptTrimmed | null): string[] {
  if (!t) return [];
  const lines: string[] = [];
  if (t.lessonsRemoved?.length) lines.push(`${count(t.lessonsRemoved.length, 'lesson')} left out`);
  if (t.downstreamTaskCap === 'title-only') lines.push('Downstream task text left out (titles, criteria and dependencies kept)');
  else if (t.downstreamTaskCap !== undefined) lines.push(`Downstream tasks cut to ${t.downstreamTaskCap.toLocaleString('en')} characters`);
  if (t.downstreamOmitted) lines.push(`${count(t.downstreamOmitted, 'downstream job')} beyond the first 20 left out`);
  if (t.downstreamRemoved?.length) lines.push(`${count(t.downstreamRemoved.length, 'downstream job')} removed to fit`);
  if (t.featureSpecCap !== undefined) lines.push(`Feature spec cut to ${t.featureSpecCap.toLocaleString('en')} characters`);
  return lines;
}

function PromptTab({ jobId }: { jobId: string }) {
  const fetchPrompt = useCallback(() => api.getJobPrompt(jobId), [jobId]);
  const { data, error } = usePolling(fetchPrompt, 60_000);
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable; the text stays selectable
    }
  }

  if (error) return <p role="alert" className="text-sm text-danger">{error.message}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const trimmed = describeTrimmed(data.trimmed);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
        {data.instructionsVersion && <Badge variant="neutral">Instructions {data.instructionsVersion}</Badge>}
        <span className="text-sm text-muted-foreground">
          {data.length.toLocaleString('en')} of {data.limit.toLocaleString('en')} characters
        </span>
      </div>
      {data.length > data.limit && (
        <p role="alert" className="rounded-md bg-danger-soft p-2 text-sm text-danger">
          This prompt is {(data.length - data.limit).toLocaleString('en')} characters over the limit even after trimming, so the job will be parked instead of fired. Shorten the task or its acceptance criteria.
        </p>
      )}
      {trimmed.length > 0 ? (
        <div className="text-sm">
          <p className="font-medium">Trimmed to fit the limit</p>
          <ul className="list-disc pl-5 text-muted-foreground">
            {trimmed.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing trimmed.</p>
      )}
      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-3 font-mono text-xs">{data.text}</pre>
    </div>
  );
}

export function JobDetailView() {
  const { id } = useParams<{ id: string }>();
  const fetchJob = useCallback(() => api.getJob(id), [id]);
  const job = usePolling(fetchJob, POLL_MS);
  const fetchRevisions = useCallback(() => api.listJobRevisions(id), [id]);
  const revisions = usePolling(fetchRevisions, 15_000);
  const j = job.data;
  const projectId = j?.projectId;
  const fetchRepos = useCallback(() => (projectId ? api.listRepos(projectId) : Promise.resolve([])), [projectId]);
  const fetchJobs = useCallback(() => (projectId ? api.listJobs(projectId) : Promise.resolve([])), [projectId]);
  const fetchFeature = useCallback(() => (j?.featureId ? api.getFeature(j.featureId) : Promise.resolve(null)), [j?.featureId]);
  const repos = usePolling(fetchRepos, 60_000);
  const projectJobs = usePolling(fetchJobs, 30_000);
  const feature = usePolling(fetchFeature, 60_000);

  if (job.error && !j) {
    const missing = (job.error as { status?: number }).status;
    return (
      <EmptyState
        title="Job not found"
        text={missing === 404 || missing === 403 || missing === 400 ? 'It does not exist or you do not have access.' : job.error.message}
        action={
          <Link href="/" className="text-sm underline">
            Back to the board
          </Link>
        }
      />
    );
  }
  if (!j) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const repoName = repos.data?.find((r) => r.id === j.repoId)?.fullName ?? j.repoId;
  const dependents = (projectJobs.data ?? []).filter((x) => x.dependsOn.includes(j.id)).map((x) => ({ id: x.id, title: x.title, status: x.status }));
  const latestCi = [...j.runs].reverse().find((r) => r.ciConclusion)?.ciConclusion ?? null;
  const revs = revisions.data ?? [];
  const timeline = buildTimeline(j, revs);
  const refreshAll = async () => {
    await Promise.all([job.refresh(), revisions.refresh()]);
  };

  return (
    <div className="space-y-4">
      <CopilotPageContext description="The job page open in the Gilde UI" value={{ jobId: j.id, title: j.title }} />
      <header className="space-y-2">
        <Link href={withProject('/', j.projectId)} className="text-sm text-muted-foreground underline">
          Board
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-display-sm">{j.title}</h1>
          <StatusBadge status={j.status} mergedBlocked={j.mergedBlocked} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <code className="font-mono text-sm">{repoName}</code>
          {j.featureId && (
            <Link href={withProject(`/features/${j.featureId}`, j.projectId)} className="underline">
              {feature.data?.title ?? 'Feature'}
            </Link>
          )}
          <span>
            Created by {j.createdBy?.name ?? 'System'} <Time iso={j.createdAt} />
          </span>
          {j.prUrl && (
            <a href={j.prUrl} target="_blank" rel="noreferrer" className="underline">
              PR #{j.prNumber}
            </a>
          )}
          {latestCi && <Badge variant={latestCi === 'success' ? 'success' : 'danger'}>CI {latestCi}</Badge>}
        </div>
        <JobActions job={j} onChanged={refreshAll} />
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="runs">Runs ({j.runs.length})</TabsTrigger>
            <TabsTrigger value="revisions">Revisions ({revs.length})</TabsTrigger>
            <TabsTrigger value="feedback">Feedback ({j.feedback.length})</TabsTrigger>
            <TabsTrigger value="prompt">Prompt</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="pt-4">
            <Overview job={j} dependents={dependents} projectId={j.projectId} />
          </TabsContent>
          <TabsContent value="runs" className="space-y-3 pt-4">
            {j.runs.length === 0 && <p className="text-sm text-muted-foreground">No runs yet</p>}
            {j.runs.length > 0 && <AgentUsageSummary t={j.agentUsage} label="Total usage, all attempts (Claude Code)" />}
            {j.runs.map((run) => (
              <RunCard key={run.id} run={run} prUrl={j.prUrl} prNumber={j.prNumber} />
            ))}
          </TabsContent>
          <TabsContent value="revisions" className="pt-4">
            <Revisions revisions={revs} onChanged={refreshAll} />
          </TabsContent>
          <TabsContent value="feedback" className="pt-4">
            <FeedbackList feedback={j.feedback} />
          </TabsContent>
          <TabsContent value="prompt" className="pt-4">
            <PromptTab jobId={j.id} />
          </TabsContent>
        </Tabs>

        <aside>
          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3 text-sm">
                {timeline.map((e, i) => (
                  <li key={i}>
                    <p>{e.label}</p>
                    <p className="text-xs text-muted-foreground">
                      <Time iso={e.at} />
                    </p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
