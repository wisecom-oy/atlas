/**
 * Graph error codes, lower-cased, that are permanent for the one item they name even when Exchange
 * sends them with a 5xx status. Repeating the request returns the same answer days later, so
 * retrying burns the whole 24-minute budget for nothing (issue #812).
 *
 * Only codes seen failing for good belong here. A code that is sometimes transient would turn a
 * recoverable failure into a permanent fallback.
 */
const PERMANENT_ITEM_ERROR_CODES = new Set(['errormimecontentconversionfailed']);

/** True when Graph answered with an error code that will not change for this item on retry. */
export function is_permanent_item_error(err: unknown): boolean {
  if (err === null || typeof err !== 'object' || !('code' in err)) return false;
  const code = err.code;
  return typeof code === 'string' && PERMANENT_ITEM_ERROR_CODES.has(code.toLowerCase());
}
