import type { SnapshotPruneOptions } from '@wisecom/atlas-types';

/** Whether the caller has asked the prune to stop. */
export function is_prune_interrupted(options: SnapshotPruneOptions): boolean {
  return options.abort_signal?.aborted === true || options.should_interrupt?.() === true;
}
