import type { ManifestObjectLockEffectivePolicy } from '@/domain/outlook/manifest';
import type { SnapshotSummary } from '@/domain/shared/snapshot-summary';
import type { ObjectStorage } from '@/ports/storage/object-storage.port';
import type { ReadableSnapshotSummaries } from '@/ports/storage/readable-listing.port';

/** What the store needs from a manifest of any workload. */
export interface StoredSnapshot {
  readonly snapshot_id: string;
  readonly created_at: Date;
  readonly entries: readonly unknown[];
  readonly object_lock?: { readonly effective: ManifestObjectLockEffectivePolicy } | undefined;
}

/** A row as every Outlook, OneDrive and SharePoint summary records it, retention included. */
export interface StoredSnapshotRow extends SnapshotSummary {
  readonly object_lock?: ManifestObjectLockEffectivePolicy | undefined;
}

/**
 * Manifests kept as plaintext JSON in a test bucket, so a repository stub reads, lists and
 * replaces them through the same storage a service deletes from. Decryption is not under test.
 */
export interface InMemorySnapshotStore<M extends StoredSnapshot> {
  /** Writes the manifest at its key, replacing whatever is there. */
  save(manifest: M): Promise<void>;
  /** Reads the manifest at `key`; undefined when absent, `unreadable(key)` when damaged. */
  read(key: string): Promise<M | undefined>;
  /** The rows of every manifest under `prefix`, with damaged ones named instead. */
  list_summaries(prefix: string): Promise<ReadableSnapshotSummaries<StoredSnapshotRow>>;
  /** Overwrites the manifest at `key` with bytes no reader accepts. */
  damage(key: string): Promise<void>;
}

const DAMAGED = Buffer.from('not a manifest');

/**
 * Builds the store. `unreadable` makes the error a damaged manifest raises; the test passes it
 * because these helpers are loaded from source and cannot import an error class at run time.
 */
export function in_memory_snapshot_store<M extends StoredSnapshot>(
  storage: ObjectStorage,
  key_of: (manifest: M) => string,
  unreadable: (key: string) => Error,
): InMemorySnapshotStore<M> {
  const read = async (key: string): Promise<M | undefined> => {
    if (!(await storage.exists(key))) return undefined;
    const body = await storage.get(key);
    let parsed: M & { created_at: string };
    try {
      parsed = JSON.parse(body.toString('utf-8')) as M & { created_at: string };
    } catch {
      throw unreadable(key);
    }
    return { ...parsed, created_at: new Date(parsed.created_at) };
  };

  return {
    save: async (manifest): Promise<void> => {
      await storage.put(key_of(manifest), Buffer.from(JSON.stringify(manifest)));
    },
    read,
    list_summaries: async (prefix): Promise<ReadableSnapshotSummaries<StoredSnapshotRow>> => {
      const summaries: StoredSnapshotRow[] = [];
      const unreadable_keys: string[] = [];
      for (const key of await storage.list(prefix)) {
        if (key.slice(prefix.length).includes('/')) continue;
        try {
          const manifest = await read(key);
          if (manifest) summaries.push(row_of(manifest, key));
        } catch {
          unreadable_keys.push(key);
        }
      }
      summaries.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      return { summaries, unreadable_keys };
    },
    damage: async (key): Promise<void> => {
      await storage.put(key, DAMAGED);
    },
  };
}

function row_of(manifest: StoredSnapshot, key: string): StoredSnapshotRow {
  return {
    snapshot_id: manifest.snapshot_id,
    created_at: manifest.created_at,
    manifest_key: key,
    entry_count: manifest.entries.length,
    total_size_bytes: 0,
    ...(manifest.object_lock !== undefined && { object_lock: manifest.object_lock.effective }),
  };
}
