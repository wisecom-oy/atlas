/**
 * Converts a site URL, hostname:/path, or GUID to a Graph `/sites` reference.
 * - GUID-only: returned as-is
 * - `hostname:/path` format: returned as-is
 * - Full URL (https://...): parsed to `hostname:/path` form
 */
export function parse_site_reference(input: string): string {
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      const path_part = url.pathname === '/' ? '' : `:${url.pathname}`;
      return `${url.hostname}${path_part}`;
    } catch {
      return input;
    }
  }
  return input;
}
