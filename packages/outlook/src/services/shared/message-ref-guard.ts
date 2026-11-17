import { ConfigError } from '@wisecom/atlas-types';

/**
 * Refuses a message reference in mailbox mode, before any storage read or Graph call.
 *
 * A message number indexes one snapshot's listing, and mailbox mode merges many snapshots, so the
 * reference has nothing to resolve against. It used to be accepted and dropped, which widened a
 * one-message restore or save to the whole mailbox (issue #705). Any supplied value is refused,
 * the empty string included, because an empty reference widens to the mailbox just the same.
 */
export function refuse_message_ref_in_mailbox_mode(message_ref: string | undefined): void {
  if (message_ref === undefined) return;
  throw new ConfigError(
    'messageRef selects a message inside one snapshot, so it is not accepted for a whole ' +
      'mailbox. Restore or save that message from its snapshot instead.',
  );
}

/**
 * Refuses a blank message reference in snapshot mode, before any storage read or Graph call.
 *
 * The snapshot path reads a blank reference as "no message selected" and processes the whole
 * snapshot, so a selector that names nothing would mean everything (issue #705).
 */
export function refuse_blank_message_ref(message_ref: string | undefined): void {
  if (message_ref === undefined || message_ref.trim() !== '') return;
  throw new ConfigError(
    'messageRef is empty. Pass a message number from the snapshot listing or a full message ID, ' +
      'or omit it to process the whole snapshot.',
  );
}
