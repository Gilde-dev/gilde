const ALLOWED = new Set(['http:', 'https:', 'mailto:']);

/**
 * The URL when it is safe to link to, else null. Only http, https and mailto are linked, plus relative paths, query strings and
 * fragments; javascript:, data:, vbscript:, file: and anything else is refused, however it is cased or padded with whitespace
 * or control characters.
 */
export function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  // Browsers drop tabs, newlines and other control characters inside a scheme, so a check must too.
  // eslint-disable-next-line no-control-regex
  const url = value.replace(/[\u0000- \u007f-\u009f]/g, '');
  if (!url) return null;
  if (url.startsWith('//')) return null;
  if (url.startsWith('/') || url.startsWith('#') || url.startsWith('?') || url.startsWith('.')) return value.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (!scheme) return value.trim(); // relative, like docs/readme.md
  return ALLOWED.has(`${scheme[1].toLowerCase()}:`) ? value.trim() : null;
}
