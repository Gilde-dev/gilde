/** Strips token-like strings and the given secrets from text that may be logged or sent to the API. */
export function sanitize(text: string, secrets: string[] = [], max = 300): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]');
  out = out.replace(/\b(xox[a-z]-|xapp-|gk_)[A-Za-z0-9_-]+/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

export function errorMessage(error: unknown, secrets: string[] = []): string {
  // Only the message: error objects from fetch can carry request details.
  return sanitize(error instanceof Error ? error.message : 'unknown error', secrets);
}
