import { extract_retry_after_ms } from '@/graph-retry-after';

/**
 * Whether a failure is Graph refusing the request before processing it: a 429, or a 503 carrying
 * Retry-After, the form SharePoint and OneDrive throttling also takes. Only these are safe to
 * repeat for a write that is not idempotent. A 509 is not among them: nothing documents that Graph
 * refuses a write with it before processing, so a write answered 509 is not sent again (#867).
 */
export function is_throttle_response(err: unknown): boolean {
  const status = status_code_of(err);
  if (status === 429) return true;
  return status === 503 && extract_retry_after_ms(err) !== undefined;
}

/** The HTTP status a Graph or network error carries, or undefined when it carries none. */
function status_code_of(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'statusCode' in err
    ? err.statusCode
    : undefined;
}
