/**
 * Folds the events of a message delta round into one final state per message ID.
 *
 * Graph can list the same message more than once in a round, on one page or across pages, and a
 * message can be removed and added again while the round is read. The round keeps the last event
 * per ID in delta order, and a message is handed over for download only the first time it is seen
 * live, so a repeat never costs a second MIME download or a second manifest entry (issue #894).
 */

import type { MailMessage } from '@wisecom/atlas-types';
import type { GraphDeltaMessage } from '@/adapters/graph-delta-message-mapper';
import { graph_message_to_mail_message } from '@/adapters/graph-delta-message-mapper';

/**
 * What one `fetch_delta` call has already reported. An invalid delta link can be rejected after
 * earlier pages were handed to `on_page`, so the full re-enumeration that follows must neither hand
 * those messages over again nor drop the removals those pages carried (issue #642).
 */
export interface DeltaHandover {
  /** IDs whose last event so far is a removal, in the order they were first removed. */
  readonly removed_ids: Set<string>;
  readonly handed_over_ids: Set<string>;
}

/** Returns an empty handover for a new `fetch_delta` call. */
export function create_delta_handover(): DeltaHandover {
  return { removed_ids: new Set(), handed_over_ids: new Set() };
}

/**
 * Applies one page's items to the round and returns the messages to hand over from it.
 *
 * `seen_ids` holds every message already handed over in this round and gains the page's messages.
 * A message the page removes after listing it live is dropped from the page before download.
 */
export function apply_delta_page_events(
  items: readonly GraphDeltaMessage[],
  removed_ids: Set<string>,
  seen_ids: Set<string>,
): MailMessage[] {
  const page = new Map<string, MailMessage>();
  for (const item of items) {
    if (!item.id) continue;
    if (item['@removed']) record_removal(item.id, page, removed_ids, seen_ids);
    else record_live_message(item, item.id, page, removed_ids, seen_ids);
  }
  return [...page.values()];
}

/** Records a removal; a message still waiting on this page is taken back off it. */
function record_removal(
  id: string,
  page: Map<string, MailMessage>,
  removed_ids: Set<string>,
  seen_ids: Set<string>,
): void {
  removed_ids.add(id);
  if (!page.delete(id)) return;
  seen_ids.delete(id);
}

/** Records a live message, queueing it on the page unless this round already handed it over. */
function record_live_message(
  item: GraphDeltaMessage,
  id: string,
  page: Map<string, MailMessage>,
  removed_ids: Set<string>,
  seen_ids: Set<string>,
): void {
  removed_ids.delete(id);
  if (seen_ids.has(id)) return;
  seen_ids.add(id);
  page.set(id, graph_message_to_mail_message(item));
}
