import { logger } from '@wisecom/atlas-core/utils/logger';

/**
 * Warns when a backup is pointed at a replication target rather than the primary bucket.
 *
 * A replica is written by the replication service, and backing up into one leaves two stores
 * that each believe they are authoritative. The check never blocks the run: an unreadable marker
 * is not a reason to refuse a backup.
 */
export async function warn_if_replica(ctx: {
  storage: { exists(key: string): Promise<boolean> };
}): Promise<void> {
  try {
    if (await ctx.storage.exists('_meta/replica.marker')) {
      logger.warn(
        'This storage target contains a replica marker (_meta/replica.marker). ' +
          'Running backup against a replica is not recommended -- use the primary storage.',
      );
    }
  } catch {
    /* non-critical: do not block backup if marker check fails */
  }
}
