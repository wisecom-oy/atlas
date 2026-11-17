import type { MailboxDeltaCursor, Manifest } from '@wisecom/atlas-types';
import { cursor_describes_head } from '@wisecom/atlas-core/services/shared/delta-cursor-binding';

/**
 * Picks the folder delta links a run or status peek may resume from.
 *
 * The cursor's links are used while the cursor still describes the head manifest. A cursor that
 * outlived its snapshot, through `delete -s`, `delete -m` or quarantine, yields no links, so every
 * folder is read in full (issues #703, #704). A mailbox with no cursor was last backed up before
 * #370 and keeps its links in the head manifest; `legacy_links` reads them.
 */
export function resumable_delta_links(
  cursor: MailboxDeltaCursor | undefined,
  head: Manifest | undefined,
  legacy_links: (head: Manifest | undefined) => Record<string, string>,
): Record<string, string> {
  if (cursor === undefined) return legacy_links(head);
  return cursor_describes_head(cursor.snapshot_id, head?.snapshot_id) ? cursor.delta_links : {};
}
