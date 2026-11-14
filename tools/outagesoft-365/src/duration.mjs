/**
 * Duration parsing for command-line values such as `30s`, `2m` or `1500ms`.
 *
 * A unit is mandatory (only a bare `0` is accepted without one) because a
 * number on its own is ambiguous: `--max-hold 120` could mean seconds or
 * milliseconds, and guessing wrong turns a two minute hold into a 120 ms one.
 */

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** Longest duration any option accepts: one day is far beyond any real outage drill. */
const MAX_DURATION_MS = 24 * 3_600_000;

/** Parses a duration string into whole milliseconds, or throws naming the bad value. */
export function parse_duration(text) {
  const value = String(text ?? '').trim();
  if (value === '0') return 0;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/i.exec(value);
  if (!match) {
    throw new Error(`invalid duration '${text}': use a number with a unit, e.g. 1500ms, 30s, 2m`);
  }
  const ms = Math.round(Number(match[1]) * UNIT_MS[match[2].toLowerCase()]);
  if (ms > MAX_DURATION_MS) throw new Error(`invalid duration '${text}': longer than 24h`);
  return ms;
}

/** Formats milliseconds compactly for terminal output (`950ms`, `12.5s`, `3m20s`). */
export function format_duration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(1))}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
}
