import type { ObjectStorage } from '@wisecom/atlas-types';
import { logger } from '@/utils/logger';

/**
 * Aborts every incomplete multipart upload under a staging prefix.
 *
 * A prefix delete removes staged objects and nothing else: an incomplete upload's parts are not
 * listed as objects, so an erasure that only deleted keys left them paying for bytes belonging to
 * an owner whose data was supposed to be gone. Nothing collects them afterwards either, because
 * the backup-side cleanup only runs when that owner is backed up again (issue #345).
 *
 * The cutoff is now, unlike the backup-side sweep: a purge is the one caller that means every
 * upload, including one a run may still be writing, because that run's destination is being erased.
 */
export async function abort_staging_uploads(storage: ObjectStorage, prefix: string): Promise<void> {
  try {
    const aborted = await storage.abort_incomplete_uploads(prefix, new Date());
    if (aborted > 0) logger.info(`Aborted ${aborted} incomplete staging upload(s) under ${prefix}`);
  } catch (err) {
    logger.warn(
      `Could not abort incomplete staging uploads under ${prefix}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Their parts survive the erasure until the bucket's lifecycle rule collects them.`,
    );
  }
}
