import { logger } from '@wisecom/atlas-core';

export interface MessageOptionScope {
  readonly snapshot?: string;
  readonly message?: string;
}

/**
 * Exits 1 when `--message` is passed without `-s`, before any storage read or Graph call.
 *
 * The `#` that `--message` takes indexes the message listing of one snapshot, and `-m` merges every
 * snapshot of the mailbox, so there is no listing for it to index. The flag used to be accepted and
 * dropped in mailbox mode, which turned a one-message restore or save into the whole mailbox
 * (issue #705). `-s` wins over `-m` in `save`, so `-s` together with `-m` still selects the message.
 */
export function refuse_message_without_snapshot(options: MessageOptionScope): void {
  if (!options.message || options.snapshot) return;
  logger.error(
    '--message selects a message inside one snapshot and needs --snapshot (-s), not --mailbox (-m). ' +
      'Find the snapshot with `atlas outlook list -m <mailbox>` and the message # with ' +
      '`atlas outlook list -s <snapshot>`.',
  );
  process.exit(1);
}
