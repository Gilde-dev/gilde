import type { NotificationKind } from '../config.js';
import type { GildeNotification, OutboundContext } from './types.js';

const MAX_REPOS = 10;
const MAX_PRS = 10;
const MAX_REASON = 600;
const MAX_TITLE = 200;

const HEADINGS: Record<NotificationKind, string> = {
  'job.awaiting_review': ':mag: PR ready for review',
  'job.parked': ':parking: Job parked',
  'job.approval_needed': ':raised_hand: Approval needed',
  'revision.waiting': ':memo: Revision proposal waiting',
  'feature.ready_to_close': ':white_check_mark: Feature ready to close',
  'budget.soft': ':warning: Budget warning',
  'budget.hard': ':no_entry: Budget limit reached',
  'executor.exhausted': ':hourglass_flowing_sand: Executor exhausted',
  'spec.planned': ':clipboard: Spec planned',
  'spec.plan_failed': ':x: Spec planning failed',
};

/** Escapes Slack control characters and defuses @channel/@here/@everyone and user-group mentions. */
export function escapeSlack(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@(channel|here|everyone|[Ss]\w*team)\b/g, '@​$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function link(url: string, label: string): string {
  if (!/^https?:\/\//i.test(url)) return escapeSlack(label);
  const safeUrl = url.replace(/[<>|\s]/g, (c) => encodeURIComponent(c));
  return `<${safeUrl}|${escapeSlack(label).replace(/\|/g, '¦')}>`;
}

/** Deep link: a job opens in the dashboard modal, a feature on its detail page. Null when the event has neither. */
export function deepLink(n: GildeNotification, publicUrl: string): string | null {
  if (isBudget(n)) {
    // A project budget lives in that project's settings; the global one is shown on the metrics page.
    return n.budget?.scope === 'project' && n.projectId ? `${publicUrl}/settings/projects/${encodeURIComponent(n.projectId)}` : `${publicUrl}/metrics`;
  }
  if (n.jobId) {
    const query = new URLSearchParams();
    if (n.projectId) query.set('project', n.projectId);
    query.set('job', n.jobId);
    return `${publicUrl}/?${query.toString()}`;
  }
  if (n.featureId) return `${publicUrl}/features/${encodeURIComponent(n.featureId)}`;
  return null;
}

function bounded<T>(items: T[], max: number, render: (item: T) => string): string {
  const shown = items.slice(0, max).map(render).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

const isBudget = (n: GildeNotification) => n.kind === 'budget.soft' || n.kind === 'budget.hard';

const usd = (n: number) => `$${n.toFixed(2)}`;

/** `00:00 UTC` for a day, `Mon 00:00 UTC` for a week (resets are always UTC midnights). */
function resetLabel(iso: string, period: 'day' | 'week'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'at the next UTC reset';
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
  return period === 'week' ? `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.toISOString().slice(0, 10)} ${time}` : time;
}

/** Budget alert: no job, PR or repo lines; spend, limit, scope, period and reset come from the structured facts. */
function formatBudget(n: GildeNotification, publicUrl: string): string {
  const b = n.budget;
  const url = deepLink(n, publicUrl);
  const lines = [`*${HEADINGS[n.kind]}*`];
  const title = truncate(n.title, MAX_TITLE);
  if (!b) {
    lines.push(`${escapeSlack(title)}: ${escapeSlack(truncate(n.reason, MAX_REASON)) || '_no details_'}`);
  } else if (b.reasonKind === 'configError') {
    lines.push(`${escapeSlack(title)}: the ${b.scope} ${b.period === 'day' ? 'daily' : 'weekly'} limit setting \`${escapeSlack(b.variable ?? 'unknown').replace(/`/g, "'")}\` is invalid. New automatic dispatch is stopped until it is corrected; a reset does not clear this.`);
  } else {
    const span = b.period === 'day' ? 'today' : 'this week';
    const limit = b.limit === null ? 'no limit' : usd(b.limit);
    const percent = b.percent === null ? '' : ` (${Math.floor(b.percent)}%)`;
    lines.push(`${escapeSlack(title)}: ${usd(b.spent)} of ${limit} estimated ${span}${percent}. Resets ${resetLabel(b.resetsAt, b.period)}.`);
  }
  if (b && b.unpricedRows > 0) {
    lines.push(`_Estimate may be too low: ${b.unpricedRows} usage record${b.unpricedRows === 1 ? ' has' : 's have'} no price._`);
  }
  lines.push(
    n.kind === 'budget.hard'
      ? 'New automatic dispatch is stopped until the period resets or the limit changes. Running work and human use of Gilde continue.'
      : 'Only a warning: nothing is stopped.',
  );
  if (url) lines.push(`Details: ${link(url, b?.scope === 'project' ? 'Open project settings in Gilde' : 'Open metrics in Gilde')}`);
  return lines.join('\n');
}

/**
 * Werkmeester outcome: planned links the draft feature (nothing is queued yet); a failure gives the short reason and links the
 * spec when the envelope names it. No job or PR lines.
 */
function formatSpecPlan(n: GildeNotification, publicUrl: string): string {
  const title = truncate(n.title, MAX_TITLE);
  const reason = escapeSlack(truncate(n.reason, MAX_REASON)) || '_no details_';
  if (n.kind === 'spec.planned') {
    const url = n.featureId ? `${publicUrl}/features/${encodeURIComponent(n.featureId)}` : null;
    return [`*${HEADINGS[n.kind]}*`, url ? `*${link(url, title)}*` : `*${escapeSlack(title)}*`, `Plan: ${reason}`,
      ...(url ? [`Review and queue the jobs: ${link(url, 'Open feature in Gilde')}`] : [])].join('\n');
  }
  return [`*${HEADINGS[n.kind]}*`, `*${escapeSlack(title)}*`, `Reason: ${reason}`, 'Nothing was created. Plan it again from the spec page.'].join('\n');
}

/** Deterministic mrkdwn text for one notification; no LLM involved. */
export function formatSlack(n: GildeNotification, { publicUrl }: OutboundContext): string {
  if (isBudget(n)) return formatBudget(n, publicUrl);
  if (n.kind === 'executor.exhausted') {
    // No job, repo or PR: the reason names the executor, its owner and the reset time.
    return [`*${HEADINGS[n.kind]}*`, escapeSlack(truncate(n.reason, MAX_REASON)) || '_no details_', `Manage: ${link(`${publicUrl}/settings/executors`, 'Open executors in Gilde')}`].join('\n');
  }
  if (n.kind === 'spec.planned' || n.kind === 'spec.plan_failed') return formatSpecPlan(n, publicUrl);
  const url = deepLink(n, publicUrl);
  const title = truncate(n.title, MAX_TITLE);
  const lines = [`*${HEADINGS[n.kind]}*`, url ? `*${link(url, title)}*` : `*${escapeSlack(title)}*`];

  lines.push(`Repo${n.repos.length === 1 ? '' : 's'}: ${n.repos.length ? bounded(n.repos, MAX_REPOS, (r) => `\`${escapeSlack(r).replace(/`/g, "'")}\``) : '_none_'}`);
  lines.push(`Reason: ${escapeSlack(truncate(n.reason, MAX_REASON)) || '_none given_'}`);

  if (n.prLinks.length > 0) {
    const label = n.prLinks.length === 1 ? 'PR' : 'PRs';
    lines.push(`${label}: ${bounded(n.prLinks, MAX_PRS, (pr) => link(pr.url, `${pr.repo}#${pr.number}`))}`);
  } else {
    lines.push(n.kind === 'job.parked' ? 'PR: none yet (parked before a PR was opened)' : 'PR: none yet');
  }
  if (url) lines.push(n.kind === 'feature.ready_to_close' ? `Details: ${link(url, 'Open feature in Gilde')}` : `Open in Gilde: ${link(url, 'job')}`);
  return lines.join('\n');
}
