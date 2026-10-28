const FIRE_PATH = /^\/v1\/claude_code\/routines\/[A-Za-z0-9_-]+\/fire$/;

/**
 * Mirror of `FireUrlSchema` in apps/api/src/executor/executor.dto.ts: https only, api.anthropic.com, no credentials, port,
 * query or fragment. `fire-url.spec.ts` and `executor.dto.spec.ts` check the same examples; change them together.
 */
export function isFireUrl(input: string): boolean {
  const value = input.trim();
  if (value.length > 500) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' && url.hostname === 'api.anthropic.com' && !url.port && !url.username && !url.password
    && !url.search && !url.hash && FIRE_PATH.test(url.pathname)
  );
}

export const FIRE_URL_HINT = 'Must look like https://api.anthropic.com/v1/claude_code/routines/<id>/fire';
