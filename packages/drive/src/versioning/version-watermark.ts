import type { DriveVersionWatermark } from '@/drive-ports';

/**
 * Version dedup watermarks (issue #161).
 *
 * A timestamp skips all older versions without reading the full version
 * index. Graph timestamps have only second precision, so the watermark also
 * carries every captured version id at its boundary timestamp. Version ids
 * are equality keys only: Graph does not guarantee their format or ordering.
 *
 * Legacy cursors stored only the timestamp. Equal-timestamp versions are
 * conservatively recaptured once while that string is upgraded to an exact
 * watermark; losing history is more expensive than one redundant download.
 */

/**
 * Epoch millis for a Graph timestamp. Returns `undefined` for a missing or
 * unparseable value so callers can treat it as "no usable position in time"
 * rather than silently sorting it to the epoch.
 */
export function version_timestamp_ms(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Whether this exact historical version is already captured. */
export function is_version_already_captured(
  version_id: string,
  version_last_modified_at: string | undefined,
  watermark: DriveVersionWatermark | string | undefined,
): boolean {
  const mark = version_timestamp_ms(
    typeof watermark === 'string' ? watermark : watermark?.last_modified_at,
  );
  if (mark === undefined) return false;
  const at = version_timestamp_ms(version_last_modified_at);
  if (at === undefined) return false;
  if (at !== mark) return at < mark;
  return typeof watermark === 'object' && watermark.version_ids.includes(version_id);
}

/** Advances an exact watermark, treating an unusable timestamp as no advance. */
export function later_watermark(
  current: DriveVersionWatermark | string | undefined,
  candidate_at: string | undefined,
  candidate_version_id: string,
): DriveVersionWatermark | string | undefined {
  const next = version_timestamp_ms(candidate_at);
  if (next === undefined || candidate_at === undefined) return current;
  const now = version_timestamp_ms(
    typeof current === 'string' ? current : current?.last_modified_at,
  );
  if (now !== undefined && next < now) return current;
  if (now === undefined || next > now) {
    return { last_modified_at: candidate_at, version_ids: [candidate_version_id] };
  }
  if (typeof current === 'object' && current.version_ids.includes(candidate_version_id)) {
    return current;
  }
  const version_ids =
    typeof current === 'object'
      ? [...current.version_ids, candidate_version_id].sort()
      : [candidate_version_id];
  return { last_modified_at: candidate_at, version_ids };
}

/** Orders versions oldest first, so a watermark can stop at the first uncaptured one. */
export function by_version_age<T extends { last_modified_at?: string }>(a: T, b: T): number {
  const left = version_timestamp_ms(a.last_modified_at) ?? Number.NEGATIVE_INFINITY;
  const right = version_timestamp_ms(b.last_modified_at) ?? Number.NEGATIVE_INFINITY;
  return left - right;
}
