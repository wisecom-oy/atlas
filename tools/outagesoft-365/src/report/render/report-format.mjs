/**
 * Formatting shared by the Markdown and terminal renderers.
 *
 * Generated prose follows the repository writing rules, so no formatter here emits an em dash or a
 * double hyphen; a missing value renders as `n/a`.
 */

/** Milliseconds as `850ms`, `12.4s` or `3m 05s`; `n/a` for null. */
export function format_ms(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return 'n/a';
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${sign}${Math.round(abs)}ms`;
  if (abs < 60_000) return `${sign}${(abs / 1000).toFixed(abs < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(abs / 60_000);
  const seconds = Math.round((abs % 60_000) / 1000);
  return `${sign}${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Offset from time zero as `+20s`, for timeline rows and window starts. */
export function format_offset(ms) {
  return ms === 0 ? '+0s' : `+${format_ms(ms)}`;
}

/** A fraction as a percentage with one decimal, `n/a` when the denominator is zero. */
export function format_pct(part, whole) {
  if (!whole) return 'n/a';
  return `${((part / whole) * 100).toFixed(1)} %`;
}

/** Byte counts the way graph-tap prints them. */
export function format_bytes(n) {
  if (n < 1024) return `${n}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)}${units[i]}`;
}

/** `[{ key, count }]` as `200×12 429×3`, graph-tap's status mix notation. */
export function format_mix(entries, limit = 8) {
  if (!entries.length) return 'none';
  const shown = entries.slice(0, limit).map((e) => `${e.key}×${e.count}`);
  if (entries.length > limit) shown.push(`+${entries.length - limit} more`);
  return shown.join(' ');
}

/** `min / median / max` of a list summary, or `n/a`. */
export function format_spread(summary) {
  if (!summary || !summary.count) return 'n/a';
  return `${format_ms(summary.min)} / ${format_ms(summary.median)} / ${format_ms(summary.max)}`;
}

/** `was` or `were` for a count. */
export function was_were(count) {
  return count === 1 ? 'was' : 'were';
}

/** Singular or plural noun with its count. */
export function plural(count, noun, plural_noun = `${noun}s`) {
  return `${count} ${count === 1 ? noun : plural_noun}`;
}
