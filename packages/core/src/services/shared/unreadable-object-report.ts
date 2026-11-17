import { UnreadableObjectsError } from '@wisecom/atlas-types';

/**
 * Returns a listing when every object was read, and raises `UnreadableObjectsError` carrying it as
 * `partial_result` when some were not.
 *
 * Listings return arrays, which have nowhere to carry the skipped keys without a breaking change
 * to the result type. Raising with the readable rows attached keeps both: a caller that does not
 * look sees a failure with each key named and a non-zero exit, and one that does still gets every
 * snapshot that could be read (issue #631).
 */
export function return_or_raise_partial<T>(unreadable_keys: readonly string[], result: T): T {
  if (unreadable_keys.length === 0) return result;
  throw new UnreadableObjectsError(
    `${unreadable_keys.length} stored object(s) could not be read and are not listed`,
    unreadable_keys,
    { partial_result: result },
  );
}

/**
 * Adds `unreadable_keys` to a result when an operation skipped damaged objects it did not need,
 * and leaves the result untouched otherwise, so a clean run's result is unchanged (issue #631).
 */
export function with_unreadable_keys<T extends object>(
  result: T,
  unreadable_keys: readonly string[],
): T & { unreadable_keys?: string[] } {
  return unreadable_keys.length === 0
    ? result
    : { ...result, unreadable_keys: [...unreadable_keys] };
}

/** Adds `unreadable_keys` to a backup result's summary when the run skipped damaged manifests. */
export function with_summary_unreadable_keys<T extends { readonly summary: object }>(
  result: T,
  unreadable_keys: readonly string[],
): T {
  if (unreadable_keys.length === 0) return result;
  return { ...result, summary: with_unreadable_keys(result.summary, unreadable_keys) };
}
