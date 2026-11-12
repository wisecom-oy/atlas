import { logger } from '@wisecom/atlas-core';

export interface MessageOptionScope {
  readonly snapshot?: string;
  readonly message?: string;
}

/** Exits 1 when `--message` cannot name exactly one message: without `-s`, or blank. */
export function validate_message_option(options: MessageOptionScope): void {
  refuse_message_without_snapshot(options);
  refuse_blank_message(options);
}

/**
 * Exits 1 when `--message` is passed without `-s`, before any storage read or Graph call.
 *
 * The `#` that `--message` takes indexes the message listing of one snapshot, and `-m` merges every
 * snapshot of the mailbox, so there is no listing for it to index. The flag used to be accepted and
 * dropped in mailbox mode, which turned a one-message restore or save into the whole mailbox
 * (issue #705). `-s` wins over `-m` in `save`, so `-s` together with `-m` still selects the message.
 * The check is on presence, not truthiness: `--message ''` would otherwise slip through and widen
 * to the mailbox the same way.
 */
function refuse_message_without_snapshot(options: MessageOptionScope): void {
  if (options.message === undefined || options.snapshot) return;
  logger.error(
    '--message selects a message inside one snapshot and needs --snapshot (-s), not --mailbox (-m). ' +
      'Find the snapshot with `atlas outlook list -m <mailbox>` and the message # with ' +
      '`atlas outlook list -s <snapshot>`.',
  );
  process.exit(1);
}

/**
 * Exits 1 when `--message` is blank. Snapshot mode reads a blank selector as "no message selected"
 * and processes the whole snapshot, so a selector that names nothing would mean everything.
 */
function refuse_blank_message(options: MessageOptionScope): void {
  if (options.message === undefined || options.message.trim() !== '') return;
  logger.error(
    '--message is empty. Pass a message # from `atlas outlook list -s <snapshot>` or a full ' +
      'message ID, or omit --message to process the whole snapshot.',
  );
  process.exit(1);
}
