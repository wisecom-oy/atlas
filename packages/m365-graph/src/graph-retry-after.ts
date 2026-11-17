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
 * The longest Retry-After Atlas waits out. Anything longer is clamped by `parse_retry_after_ms`, and
 * `with_graph_retry` fails the call naming the value rather than waiting it.
 *
 * The throttle fence's timer is not `unref`'d, so it holds the event loop open: without a ceiling, a
 * header that parsed to a date a year out would park the whole Outlook path for a year.
 */
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/**
 * Parses a `Retry-After` value into milliseconds, clamped to `MAX_RETRY_AFTER_MS`, or undefined when
 * it carries no usable wait.
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
  const requested = parse_requested_retry_after_ms(value, now);
  return requested === undefined ? undefined : Math.min(requested, MAX_RETRY_AFTER_MS);
}

/** Parses a `Retry-After` value into the wait it asks for in milliseconds, without the clamp. */
function parse_requested_retry_after_ms(
  value: string | null | undefined,
  now: number,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  // Digits first, and never fall through to Date.parse for them: Date.parse('120') is the year 120,
  // and Date.parse('-5') is a real date in 2001, so letting a numeric value reach it turns a
  // two-minute wait into a nonsense one.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;

  const wait = when - now;
  return wait > 0 ? wait : undefined;
}

/**
 * Reads `Retry-After` from a Graph or network error, or undefined when it carries none.
 *
 * The Graph SDK stores the raw response's fetch `Headers` object on the error. That object answers
 * `get()`, not property reads, so a plain `headers['retry-after']` never found the header and every
 * 429 fell back to the default cooldown. Both shapes are read here.
 */
export function extract_retry_after_ms(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('headers' in err)) return undefined;
  return parse_retry_after_ms(read_header(err.headers, 'retry-after'));
}

/**
 * Reads the wait `Retry-After` asks for from a Graph or network error, without clamping it to
 * `MAX_RETRY_AFTER_MS`, so a value past the cap can be reported as sent.
 */
export function extract_requested_retry_after_ms(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('headers' in err)) return undefined;
  return parse_requested_retry_after_ms(read_header(err.headers, 'retry-after'), Date.now());
}

function has_get(headers: object): headers is { get(name: string): unknown } {
  return 'get' in headers && typeof headers.get === 'function';
}

function read_header(headers: unknown, name: string): string | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  if (has_get(headers)) {
    const value: unknown = headers.get(name);
    return typeof value === 'string' ? value : undefined;
  }
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value: unknown = match?.[1];
  return typeof value === 'string' ? value : undefined;
}
