import { NOTIFICATION_KINDS, type NotificationKind } from '../config.js';
import { notification } from './fixtures.js';
import type { GildeNotification } from './types.js';
import { deepLink, escapeSlack, formatSlack } from './format-slack.js';

const ctx = { publicUrl: 'https://gilde.example.com' };

const JOB_KINDS = NOTIFICATION_KINDS.filter((k) => !k.startsWith('budget.') && k !== 'executor.exhausted');

describe('formatSlack', () => {
  it.each(JOB_KINDS)('shows title, repo, reason, deep link and PR for %s', (kind) => {
    const text = formatSlack(notification({ kind, jobId: kind === 'feature.ready_to_close' ? null : 'j1', featureId: kind === 'feature.ready_to_close' ? 'f1' : null }), ctx);
    expect(text).toContain('Add thing');
    expect(text).toContain('`gilde-dev/gilde`');
    expect(text).toContain('Reason: CI passed');
    expect(text).toContain('<https://github.com/gilde-dev/gilde/pull/5|gilde-dev/gilde#5>');
    expect(text).toContain(kind === 'feature.ready_to_close' ? 'https://gilde.example.com/features/f1' : 'https://gilde.example.com/?project=p1&job=j1');
  });

  it('says there is no PR yet for parked jobs and others', () => {
    expect(formatSlack(notification({ kind: 'job.parked', prLinks: [] }), ctx)).toContain('PR: none yet (parked');
    expect(formatSlack(notification({ prLinks: [] }), ctx)).toContain('PR: none yet');
  });

  it('bounds repos and PRs for features', () => {
    const repos = Array.from({ length: 25 }, (_, i) => `o/r${i}`);
    const prLinks = repos.map((repo, i) => ({ repo, number: i, url: `https://github.com/${repo}/pull/${i}` }));
    const text = formatSlack(notification({ kind: 'feature.ready_to_close', jobId: null, featureId: 'f1', repos, prLinks }), ctx);
    expect(text).toContain('and 15 more');
    expect(text).not.toContain('o/r24');
    expect(text.length).toBeLessThan(3000);
  });

  it('escapes markup and defuses mass mentions in untrusted fields', () => {
    const text = formatSlack(notification({ title: '<!channel> & <@U1> |x>', reason: '@here @everyone <!subteam^S1>', repos: ['a`b/c'] }), ctx);
    expect(text).not.toMatch(/<!channel>|<@U1>|<!subteam/);
    expect(text).not.toMatch(/@(here|everyone|channel)/);
    expect(text).toContain('&lt;!channel&gt; &amp;');
  });

  it('does not link non-http PR urls', () => {
    const text = formatSlack(notification({ prLinks: [{ repo: 'o/r', number: 1, url: 'javascript:alert(1)' }] }), ctx);
    expect(text).not.toContain('javascript:');
  });
});

const budget = (kind: NotificationKind, b: Partial<NonNullable<GildeNotification['budget']>> = {}, over: Partial<GildeNotification> = {}) =>
  notification({
    kind, jobId: null, projectId: null, title: 'Budget Gilde', repos: [], prLinks: [], reason: 'ignored when structured',
    budget: { scope: 'global', period: 'day', state: kind === 'budget.hard' ? 'hard' : 'soft', spent: 8.1, limit: 10, percent: 81.2, startsAt: '2026-03-10T00:00:00.000Z', resetsAt: '2026-03-11T00:00:00.000Z', unpricedRows: 0, reasonKind: 'limit', variable: null, ...b },
    ...over,
  });

describe('formatSlack executor.exhausted', () => {
  it('names the executor, owner and reset time, links to the executors page and has no job lines', () => {
    const text = formatSlack(notification({
      kind: 'executor.exhausted', jobId: null, projectId: null, repos: [], prLinks: [], title: 'Executor laptop',
      reason: 'Pascal\'s executor "laptop" hit its usage limit; no jobs fire on it until 2026-10-28T12:00:00.000Z',
    }), ctx);
    expect(text).toContain('Executor exhausted');
    expect(text).toContain('until 2026-10-28T12:00:00.000Z');
    expect(text).toContain('https://gilde.example.com/settings/executors');
    expect(text).not.toContain('Repo');
    expect(text).not.toContain('PR:');
  });
});

describe('formatSlack budget alerts', () => {
  it('renders the global daily soft alert without job, PR or repo data', () => {
    const text = formatSlack(budget('budget.soft'), ctx);
    expect(text).toContain('Budget Gilde: $8.10 of $10.00 estimated today (81%). Resets 00:00 UTC.');
    expect(text).toContain('<https://gilde.example.com/metrics|Open metrics in Gilde>');
    expect(text).not.toMatch(/Repo|PR:|Reason:|\/\?job=/);
    expect(text).toContain('nothing is stopped');
  });

  it('distinguishes project and week, links the project settings and says dispatch stops on hard', () => {
    const text = formatSlack(budget('budget.hard', { scope: 'project', period: 'week', spent: 12, limit: 10, percent: 120, resetsAt: '2026-03-16T00:00:00.000Z' }, { title: 'Budget Acme', projectId: 'p 1' }), ctx);
    expect(text).toContain('Budget Acme: $12.00 of $10.00 estimated this week (120%). Resets Mon 2026-03-16 00:00 UTC.');
    expect(text).toContain('<https://gilde.example.com/settings/projects/p%201|Open project settings in Gilde>');
    expect(text).toContain('New automatic dispatch is stopped');
    expect(text).toContain('human use of Gilde continue');
  });

  it('shows the unpriced caveat only when present, singular and plural', () => {
    expect(formatSlack(budget('budget.soft'), ctx)).not.toContain('no price');
    expect(formatSlack(budget('budget.soft', { unpricedRows: 1 }), ctx)).toContain('1 usage record has no price');
    expect(formatSlack(budget('budget.soft', { unpricedRows: 3 }), ctx)).toContain('3 usage records have no price');
  });

  it('handles a zero limit (no percent) and keeps the config error explanation without any value', () => {
    expect(formatSlack(budget('budget.hard', { limit: 0, spent: 0, percent: null }), ctx)).toContain('$0.00 of $0.00 estimated today. Resets');
    const text = formatSlack(budget('budget.hard', { reasonKind: 'configError', variable: 'GLOBAL_DAILY_BUDGET_USD', limit: null, percent: null }), ctx);
    expect(text).toContain('`GLOBAL_DAILY_BUDGET_USD` is invalid');
    expect(text).toContain('a reset does not clear this');
  });

  it('escapes the title and falls back to the reason without structured facts', () => {
    expect(formatSlack(budget('budget.soft', {}, { title: '<!channel> & <@U1>' }), ctx)).not.toMatch(/<!channel>|<@U1>/);
    const text = formatSlack(budget('budget.hard', {}, { budget: null, reason: '@here limit <x>' }), ctx);
    expect(text).toContain('Budget Gilde: @\u200bhere limit &lt;x&gt;');
  });
});

describe('deepLink', () => {
  it('links budget alerts to project settings or global metrics', () => {
    expect(deepLink(budget('budget.soft'), 'https://g')).toBe('https://g/metrics');
    expect(deepLink(budget('budget.soft', { scope: 'project' }, { projectId: 'p1' }), 'https://g')).toBe('https://g/settings/projects/p1');
  });

  it('links jobs to the dashboard, features to their page, and nothing otherwise', () => {
    expect(deepLink(notification({ projectId: null }), 'https://g')).toBe('https://g/?job=j1');
    expect(deepLink(notification({ jobId: null, featureId: 'f 1' }), 'https://g')).toBe('https://g/features/f%201');
    expect(deepLink(notification({ jobId: null }), 'https://g')).toBeNull();
  });
});

describe('escapeSlack', () => {
  it('collapses whitespace', () => expect(escapeSlack('a\n\nb')).toBe('a b'));
});
