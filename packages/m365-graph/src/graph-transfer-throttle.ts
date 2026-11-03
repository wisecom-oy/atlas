import type { GraphServicePool } from '@wisecom/atlas-types';
import { get_active_throttle } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { FailOpenThrottleCoordinator } from '@/fail-open-throttle-coordinator';
import { parse_retry_after_ms } from '@/graph-retry-after';

/** The pool OneDrive and SharePoint content transfers are charged to, shared with their metadata calls. */
const TRANSFER_POOL: GraphServicePool = 'sharepoint_onedrive';

/**
 * Waits out any cooldown on the transfer pool before a content or upload request is sent.
 *
 * Call it before arming a per-attempt timeout, so time spent in a cooldown is not counted as a stalled transfer.
 * Fails open: a coordinator whose `wait` rejects lets the request through.
 */
export async function wait_for_transfer_slot(): Promise<void> {
  const active = get_active_throttle();
  if (!active) return;
  await new FailOpenThrottleCoordinator(active.coordinator).wait(TRANSFER_POOL);
}

/**
 * Reports a throttled transfer response to the ambient coordinator.
 *
 * Only a 429 or 503 carrying a usable Retry-After raises a cooldown. Other responses, and throttles without the header, stay with the caller's own backoff.
 * Fails open: a coordinator whose `raise` throws or rejects is logged, and the caller's retry loop carries on.
 */
export function report_transfer_throttle(response: Pick<Response, 'status' | 'headers'>): void {
  if (response.status !== 429 && response.status !== 503) return;
  const retry_after_ms = parse_retry_after_ms(response.headers.get('Retry-After'));
  if (retry_after_ms === undefined || retry_after_ms <= 0) return;
  const active = get_active_throttle();
  if (!active) return;
  new FailOpenThrottleCoordinator(active.coordinator).raise(TRANSFER_POOL, retry_after_ms);
}
