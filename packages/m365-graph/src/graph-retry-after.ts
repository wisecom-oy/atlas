/**
 * One `Retry-After` parser for every retry loop that talks to Microsoft 365.
 *
 * RFC 9110 allows two forms and Atlas only understood one: `parseInt` on an HTTP-date returns NaN,
 * so a server that answered `Retry-After: Wed, 26 Aug 2026 10:02:00 GMT` had its instruction
 * discarded and got exponential backoff instead (issue #203). Graph commits to the seconds form in
 * its documented throttling guidance, but the CDN in front of it and SharePoint's own endpoints are
 * not bound by that.
 */

/**
 * Anything longer than this is treated as a misparse rather than an instruction.
 *
 * Two reasons, and the second is the load-bearing one. `with_graph_retry` already clamps its own
 * sleep to 5 minutes, so a silly value could not stall a single attempt. The throttle fence has no
 * such clamp, and since its timer stopped being `unref`'d it holds the event loop open, so a header
 * that parsed to a date a year out would park the whole Outlook path for a year.
 */
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/**
 * Parses a `Retry-After` value into milliseconds, or undefined when it carries no usable wait.
 *
 * Undefined means "no instruction", which leaves the caller's exponential backoff in charge. A
 * past-dated header resolves to a non-positive wait and is reported that way rather than as zero,
 * because zero would suppress the backoff and jitter that stop concurrent callers retrying in
 * lockstep.
 */
export function parse_retry_after_ms(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  // Digits first, and never fall through to Date.parse for them: Date.parse('120') is the year 120,
  // and Date.parse('-5') is a real date in 2001, so letting a numeric value reach it turns a
  // two-minute wait into a nonsense one.
  if (/^\d+$/.test(trimmed)) {
    return clamp(Number(trimmed) * 1000);
  }

  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;

  const wait = when - now;
  return wait > 0 ? clamp(wait) : undefined;
}

function clamp(ms: number): number {
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}
