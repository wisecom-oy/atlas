/**
 * The random delay added after a Graph cooldown ends, so callers released by it do not all send
 * their next request in the same instant and trip the 429 again (issue #641).
 *
 * The delay is always added, never subtracted, so no request goes out before the Retry-After Graph
 * asked for. Its bound is a tenth of the cooldown, kept between one and five seconds. One second is
 * the jitter Microsoft's Graph JavaScript SDK adds to its own retry delays. A tenth keeps the
 * spread proportional to how long the callers were parked, and five seconds stops it from adding
 * more than a moment to a cooldown of many minutes while still spreading a pool of parked callers
 * across several request round trips.
 */

const MIN_JITTER_BOUND_MS = 1_000;
/** The longest delay a cooldown release can add. */
export const MAX_COOLDOWN_RELEASE_JITTER_MS = 5_000;
const JITTER_SHARE_OF_COOLDOWN = 0.1;

/** The upper bound of the release delay for a cooldown of `cooldown_ms`. */
export function cooldown_release_jitter_bound_ms(cooldown_ms: number): number {
  const proportional = Math.max(cooldown_ms, 0) * JITTER_SHARE_OF_COOLDOWN;
  return Math.min(Math.max(proportional, MIN_JITTER_BOUND_MS), MAX_COOLDOWN_RELEASE_JITTER_MS);
}

/** A random delay in `[0, bound)` to add after a cooldown of `cooldown_ms` ends. */
export function cooldown_release_jitter_ms(cooldown_ms: number): number {
  return Math.random() * cooldown_release_jitter_bound_ms(cooldown_ms);
}
