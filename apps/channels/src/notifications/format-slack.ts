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

/** Deterministic mrkdwn text for one notification; no LLM involved. */
export function formatSlack(n: GildeNotification, { publicUrl }: OutboundContext): string {
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
