import type { HeldOwnerLease } from '@wisecom/atlas-types';

/**
 * True while the run still holds the lease, false once `assert_held` would throw. Use it where a
 * lost lease should skip a step rather than fail the run.
 */
export function holds_lease(lease: HeldOwnerLease): boolean {
  try {
    lease.assert_held();
    return true;
  } catch {
    return false;
  }
}
