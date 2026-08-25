/**
 * Version dedup watermarks (issue #161).
 *
 * A backup must decide, before spending a Graph download, whether it already
 * captured a historical version of a file. The obvious answer is a set of
 * every version id ever captured, but that set only exists in the version
 * index, and reading it costs one GET per backup run ever performed for the
 * owner: at a thousand sites and years of daily backups the preload alone
 * outgrows the backup window.
 *
 * Graph gives a cheaper key. `driveItem/versions` returns versions ordered
 * newest first, each carrying `lastModifiedDateTime`, and a version's
 * timestamp never changes once written: restoring an old version creates a
 * new version with a current timestamp rather than resurrecting the old one.
 * Version history is therefore totally ordered in time, and a single
 * timestamp per file replaces the whole id set. That fits in the delta
 * cursor, which every run already reads and writes.
 *
 * Deliberately not keyed on `driveItemVersion.id`: the Graph reference
 * documents it only as "The ID of the version", with no format or ordering
 * guarantee. Real values look like `3.0`, SharePoint adds minor versions like
 * `1.1`, and libraries prune old versions server-side once the version limit
 * is reached. Parsing it would be relying on undocumented behaviour.
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

/**
 * Whether a version is at or below the file's watermark and can be skipped.
 *
 * Conservative by design: a version with no usable timestamp is never treated
 * as captured, because skipping it would drop history on an unprovable
 * assumption. Such a version is re-downloaded on every run and deduplicated
 * at the content-addressed blob layer instead, which costs Graph bandwidth
 * but cannot lose data. Graph has always returned `lastModifiedDateTime` in
 * practice.
 */
export function is_version_already_captured(
  version_last_modified_at: string | undefined,
  watermark: string | undefined,
): boolean {
  const mark = version_timestamp_ms(watermark);
  if (mark === undefined) return false;
  const at = version_timestamp_ms(version_last_modified_at);
  if (at === undefined) return false;
  return at <= mark;
}

/** The later of two watermarks, treating an unusable timestamp as no advance. */
export function later_watermark(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined {
  const next = version_timestamp_ms(candidate);
  if (next === undefined) return current;
  const now = version_timestamp_ms(current);
  return now === undefined || next > now ? candidate : current;
}

/** Orders versions oldest first, so a watermark can stop at the first uncaptured one. */
export function by_version_age<T extends { last_modified_at?: string }>(a: T, b: T): number {
  const left = version_timestamp_ms(a.last_modified_at) ?? Number.NEGATIVE_INFINITY;
  const right = version_timestamp_ms(b.last_modified_at) ?? Number.NEGATIVE_INFINITY;
  return left - right;
}
