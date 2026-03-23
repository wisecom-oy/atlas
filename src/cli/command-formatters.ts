/** Pads a string on the right to a fixed width for table output. */
export function pad_cell(text: string, width: number): string {
  return text.padEnd(width);
}

/** Truncates long strings and appends `~` to preserve table alignment. */
export function truncate_cell(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '~' : text;
}

/** Formats byte counts using B/KB/MB/GB units. */
export function format_bytes(bytes: number, gb_precision = 1): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(gb_precision)} GB`;
}

/** Formats microseconds to `us`, `ms`, or `s` with stable precision. */
export function format_microseconds(us: number): string {
  if (us < 1000) return `${us} us`;
  const ms = us / 1000;
  if (ms < 1000) return `${ms.toFixed(2)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
