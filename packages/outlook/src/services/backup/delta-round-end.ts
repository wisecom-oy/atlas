import type { DeltaSyncResult } from '@wisecom/atlas-types';

/**
 * Throws when a delta round that ran to its end carries no delta link.
 *
 * The Graph connector already refuses such a round. This keeps any `MailboxConnector` that returns
 * one from being processed as a finished folder: its link would not be saved, but the folder would
 * be reported `[ok]` with no error and the run would exit 0 with messages missing (issue #851).
 * A round the page callback stopped early is not finished, so the caller checks only the others.
 */
export function assert_delta_round_finished(delta: DeltaSyncResult): void {
  if (delta.delta_link) return;
  throw new Error(
    'The message delta of this folder ended without a delta link, so the read is incomplete ' +
      'and the folder is read again next run',
  );
}
