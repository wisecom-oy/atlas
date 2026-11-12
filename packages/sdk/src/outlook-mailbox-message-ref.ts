import type { Writable } from 'node:stream';
import { refuse_message_ref_in_mailbox_mode } from '@wisecom/atlas-outlook';

export interface MailboxMessageRefOptions {
  readonly messageRef?: string;
  readonly output?: Writable;
}

/**
 * Rejects `messageRef` for `restoreMailbox` and `saveMailbox` before the mailbox email is resolved
 * through Graph (issue #705). The services refuse it too, but only after that lookup has run. A
 * caller's `output` stream is destroyed on rejection, as the service would have done.
 */
export function refuse_mailbox_message_ref(options: MailboxMessageRefOptions | undefined): void {
  try {
    refuse_message_ref_in_mailbox_mode(options?.messageRef);
  } catch (err) {
    options?.output?.destroy();
    throw err;
  }
}
