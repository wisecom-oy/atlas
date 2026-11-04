import type { TeamsStoredBlobRef, TeamsThreadEntry } from '@wisecom/atlas-types';

/**
 * Every blob a thread entry references: its own blob, each hosted-content item, and the last live
 * blob a tombstone kept. Verification and size totals both read blobs through this list.
 */
export function thread_stored_blobs(entry: TeamsThreadEntry): TeamsStoredBlobRef[] {
  const own: TeamsStoredBlobRef = {
    storage_key: entry.storage_key,
    checksum: entry.checksum,
    size_bytes: entry.size_bytes,
  };
  const hosted = Object.values(entry.hosted);
  return entry.last_live === undefined ? [own, ...hosted] : [own, ...hosted, entry.last_live];
}
