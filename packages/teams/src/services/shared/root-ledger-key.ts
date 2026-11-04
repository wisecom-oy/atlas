import type { FailedItemLedger } from '@wisecom/atlas-types';

/**
 * Ledger key of one root. The channel id joins the root id so equal root ids in two channels
 * never collide.
 */
export function root_ledger_key(channel_id: string, root_id: string): string {
  return `${channel_id}/${root_id}`;
}

/**
 * Re-keys entries written before the channel joined the key. Those hold a bare root id with the
 * channel as drive_id. Other entries pass through unchanged.
 */
export function migrate_legacy_root_keys(
  ledger: FailedItemLedger,
  channel_id: string,
): FailedItemLedger {
  const migrated: FailedItemLedger = {};
  for (const [key, record] of Object.entries(ledger)) {
    if (!key.includes('/') && record.drive_id === channel_id) {
      const next_key = root_ledger_key(channel_id, key);
      migrated[next_key] = { ...record, item_id: next_key };
    } else {
      migrated[key] = record;
    }
  }
  return migrated;
}
