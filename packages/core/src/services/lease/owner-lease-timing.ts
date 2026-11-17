import { randomUUID } from 'node:crypto';

/**
 * How long a lease lives after its last write, and how often its holder rewrites it.
 *
 * The trade-off is between two failures. A process that is killed cannot release its lease, so the
 * owner stays blocked until the lease runs out: at most the TTL. A holder that is alive but cannot
 * reach storage keeps the owner for the same time, then stops at its next commit point. A shorter
 * TTL frees a dead owner sooner and gives a stalled holder fewer renewal attempts; five minutes
 * with a renewal every minute leaves four attempts before the lease is gone.
 *
 * Expiry compares the `expires_at` one host wrote with another host's clock. A host whose clock
 * runs ahead by more than the time left on a live lease sees it as expired and takes the owner
 * over while the holder is still running. In steady state the time left is between four and five
 * minutes, so hosts that share a bucket must keep their clocks within a few minutes of each other.
 */
export const OWNER_LEASE_TTL_MS = 5 * 60_000;

/** How often a holder extends its lease by another TTL. */
export const OWNER_LEASE_RENEW_INTERVAL_MS = 60_000;

/**
 * How long before expiry a commit-point check already fails. A commit that starts with seconds
 * left would still be writing after another operation was entitled to take the owner over.
 */
export const OWNER_LEASE_COMMIT_MARGIN_MS = 30_000;

/** Starts calling `tick` every `interval_ms` and returns the function that stops it. */
export type OwnerLeaseScheduler = (tick: () => void, interval_ms: number) => () => void;

/** The time, timer and randomness a lease depends on, injected so tests are deterministic. */
export interface OwnerLeaseRuntime {
  /** The current time in epoch milliseconds. */
  readonly now: () => number;
  readonly schedule: OwnerLeaseScheduler;
  /** A fresh random id for one run. It identifies the run only, never a host, user or process. */
  readonly new_holder_id: () => string;
}

/** An interval timer that never keeps the process alive on its own. */
function schedule_unreferenced_interval(tick: () => void, interval_ms: number): () => void {
  const timer = setInterval(tick, interval_ms);
  timer.unref();
  return () => clearInterval(timer);
}

/** The wall clock, an unreferenced interval timer and a random UUID per run. */
export const SYSTEM_OWNER_LEASE_RUNTIME: OwnerLeaseRuntime = {
  now: () => Date.now(),
  schedule: schedule_unreferenced_interval,
  new_holder_id: () => randomUUID(),
};
