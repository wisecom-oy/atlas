import type { MailFolderListOptions, ManifestEntry } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';

/** Whether a stored entry came from the Exchange Recoverable Items subtree. */
export function is_recoverable_items_entry(entry: ManifestEntry): boolean {
  return entry.recoverable_items === true;
}

/**
 * The folder listing that can name the folder of every given entry.
 *
 * The live listing reaches the Recoverable Items subtree only on request, so a
 * Recoverable Items entry's folder is missing from it otherwise and restores
 * into `Unknown` (issue #700). Undefined when no entry needs it, so a run
 * without such entries spends not one extra request.
 */
export function folder_listing_for(
  entries: readonly ManifestEntry[],
): MailFolderListOptions | undefined {
  return entries.some(is_recoverable_items_entry) ? { include_recoverable_items: true } : undefined;
}

/**
 * Drops Recoverable Items entries unless the caller opted in, and says how many.
 *
 * Default-excluded because these are items someone deleted, or that exist only
 * because a hold retained them. Writing them back into a live mailbox on an
 * ordinary restore would resurrect deleted mail, which is a data-handling
 * problem rather than a recovery (issue #141).
 *
 * The rule has no exceptions, including a single named message: an operator who
 * means to recover purged mail says so with the flag, and the count logged here
 * is how they find out the flag is what they need. Pass only the entries the
 * operator selected, so the count names what they asked for (issue #701).
 */
export function apply_recoverable_items_policy(
  entries: ManifestEntry[],
  include: boolean | undefined,
): ManifestEntry[] {
  if (include === true) return entries;

  const kept = entries.filter((entry) => !is_recoverable_items_entry(entry));
  const dropped = entries.length - kept.length;
  if (dropped > 0) {
    logger.info(
      `Skipping ${dropped} Recoverable Items message(s); pass --include-recoverable-items to restore them.`,
    );
  }
  return kept;
}
