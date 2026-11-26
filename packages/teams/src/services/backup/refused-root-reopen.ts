import type { FailedItemLedger, FailedItemRecord } from '@wisecom/atlas-types';

/**
 * Returns the ledger with the `permanent` flag removed from every root. Before issue #896 a Teams
 * backup set that flag only for a single 400 on a root's replies or re-read, so such a root is
 * retried again under the attempt budget it has left instead of staying skipped until `--full`.
 * The ledger is returned unchanged when no root carries the flag.
 */
export function reopen_refused_roots(ledger: FailedItemLedger): FailedItemLedger {
  if (!Object.values(ledger).some((record) => record.permanent === true)) return ledger;
  return Object.fromEntries(
    Object.entries(ledger).map(([root_id, record]) => [root_id, without_permanent(record)]),
  );
}

function without_permanent(record: FailedItemRecord): FailedItemRecord {
  const { permanent: _permanent, ...rest } = record;
  return rest;
}
