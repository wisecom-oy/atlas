/** Messages processed per second based on wall-clock elapsed time. */
export function calc_rate(processed: number, elapsed_ms: number): number {
  const s = elapsed_ms / 1000;
  return s > 0 ? processed / s : 0;
}

/** Formats seconds into a human-readable duration string. */
export function format_duration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '--';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
