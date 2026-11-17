import type { Writable } from 'node:stream';
import {
  refuse_blank_message_ref,
  refuse_message_ref_in_mailbox_mode,
} from '@wisecom/atlas-outlook';

export interface MessageRefOptions {
  readonly messageRef?: string;
  readonly output?: Writable;
}

/**
 * Rejects `messageRef` for `restoreMailbox` and `saveMailbox` before the mailbox email is resolved
 * through Graph (issue #705). The services refuse it too, but only after that lookup has run.
 */
export function refuse_mailbox_message_ref(options: MessageRefOptions | undefined): void {
  refuse_destroying_output(options, refuse_message_ref_in_mailbox_mode);
}

/**
 * Rejects a blank `messageRef` for `restore` and `save` before a target mailbox is resolved
 * through Graph. The snapshot path would otherwise read it as "every message".
 */
export function refuse_blank_snapshot_message_ref(options: MessageRefOptions | undefined): void {
  refuse_destroying_output(options, refuse_blank_message_ref);
}

/** Runs the check, destroying a caller's `output` stream on rejection as the service would. */
function refuse_destroying_output(
  options: MessageRefOptions | undefined,
  check: (message_ref: string | undefined) => void,
): void {
  try {
    check(options?.messageRef);
  } catch (err) {
    options?.output?.destroy();
    throw err;
  }
}
