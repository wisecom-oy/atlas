const HOUR_MS = 60 * 60 * 1000;
const UNIT_MS: Record<string, number> = { h: HOUR_MS, d: 24 * HOUR_MS, w: 7 * 24 * HOUR_MS };

/**
 * Reads `--before` as a cut-off instant: an age such as `90d`, `12w` or `36h`, counted back from
 * `now`, or an ISO 8601 date or date-time such as `2026-08-01` or `2026-08-01T00:00:00Z`. A date
 * without a time is midnight UTC. Undefined when the value is neither, so the command refuses it
 * rather than prune to some other instant.
 */
export function parse_prune_cutoff(value: string, now: Date): Date | undefined {
  const age = /^(\d+)([hdw])$/.exec(value.trim());
  if (age?.[1] !== undefined && age[2] !== undefined) {
    const unit_ms = UNIT_MS[age[2]] ?? 0;
    return new Date(now.getTime() - Number(age[1]) * unit_ms);
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return undefined;
  const instant = new Date(value.trim());
  return Number.isNaN(instant.getTime()) ? undefined : instant;
}
