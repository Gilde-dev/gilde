import { NOTIFICATION_KINDS } from '../config.js';
import { notification } from './fixtures.js';
import { deepLink, escapeSlack, formatSlack } from './format-slack.js';

const ctx = { publicUrl: 'https://gilde.example.com' };

describe('formatSlack', () => {
  it.each(NOTIFICATION_KINDS)('shows title, repo, reason, deep link and PR for %s', (kind) => {
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

describe('deepLink', () => {
  it('links jobs to the dashboard, features to their page, and nothing otherwise', () => {
    expect(deepLink(notification({ projectId: null }), 'https://g')).toBe('https://g/?job=j1');
    expect(deepLink(notification({ jobId: null, featureId: 'f 1' }), 'https://g')).toBe('https://g/features/f%201');
    expect(deepLink(notification({ jobId: null }), 'https://g')).toBeNull();
  });
});

describe('escapeSlack', () => {
  it('collapses whitespace', () => expect(escapeSlack('a\n\nb')).toBe('a b'));
});
