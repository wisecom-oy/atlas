import type {
  HeldOwnerLease,
  ObjectStorage,
  OneDriveChangeType,
  OneDriveManifestEntry,
  OneDriveSnapshotManifest,
  SnapshotPruneOptions,
  TenantContext,
} from '@wisecom/atlas-types';
import { ObjectLockRetainedError, UnreadableObjectsError } from '@wisecom/atlas-types';
import {
  in_memory_versioned_storage,
  type InMemoryVersionedStorage,
} from '@wisecom/atlas-types/testing/in-memory-versioned-storage';
import { in_memory_snapshot_store } from '@wisecom/atlas-types/testing/in-memory-snapshot-store';
import { stub_held_owner_lease } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { prune_owner_snapshots } from '@wisecom/atlas-core/services/retention/snapshot-prune-run';
import {
  fold_drive_snapshot_chain,
  select_drive_manifest_chain,
} from '@wisecom/atlas-core/services/shared/drive-snapshot-chain';
import type { DriveFileVersionIndexView, DriveFileVersionRecord } from '@/drive-ports';
import { drive_prune_target, type DrivePruneOwner } from '@/retention/drive-prune-target';
import { records_file_content } from '@/shared/entry-kind';
import { build_drive_storage_keys, type DriveStorageKeys } from '@/shared/storage-keys';

export const OWNER = 'bbbbbbbb-0000-4000-8000-000000000002';
export type Workload = 'onedrive' | 'sharepoint';
type Manifest = OneDriveSnapshotManifest;

export function day(n: number): Date {
  return new Date(Date.UTC(2026, 0, n));
}

export function snapshot_id(n: number): string {
  return `od-snap-${day(n).getTime()}-aa`;
}

export function keys_of(workload: Workload): DriveStorageKeys {
  return build_drive_storage_keys(workload);
}

function entry(
  keys: DriveStorageKeys,
  file_id: string,
  blob: string | undefined,
  change_type: OneDriveChangeType,
): OneDriveManifestEntry {
  return {
    file_id,
    drive_id: 'drive-1',
    file_name: `${file_id}.docx`,
    parent_path: '/drive/root:',
    size_bytes: blob === undefined ? 0 : 10,
    ...(blob !== undefined && { storage_key: keys.data_key(OWNER, blob), checksum: `sha-${blob}` }),
    backup_at: '2026-01-01T00:00:00.000Z',
    change_type,
  };
}

function snapshot(n: number, entries: OneDriveManifestEntry[]): Manifest {
  return {
    id: `id-${n}`,
    tenant_id: 'tenant-test',
    owner_id: OWNER,
    snapshot_id: snapshot_id(n),
    created_at: day(n),
    total_files: entries.length,
    total_size_bytes: 0,
    entries,
  };
}

/**
 * Four runs, one a day:
 * - 1: f1 (blob a), f2 (blob b, plus an older version kept as blob v), f3 (blob c); its manifest
 *   was large and left entry parts
 * - 2: f2 changed (blob b2), f3 deleted
 * - 3: f4 created with f1's content, deduplicated to blob a; f1 deleted
 * - 4: f5 (blob e)
 */
export function history(keys: DriveStorageKeys): Manifest[] {
  return [
    snapshot(1, [
      entry(keys, 'f1', 'a', 'created'),
      entry(keys, 'f2', 'b', 'created'),
      entry(keys, 'f3', 'c', 'created'),
    ]),
    snapshot(2, [entry(keys, 'f2', 'b2', 'updated'), entry(keys, 'f3', undefined, 'deleted')]),
    snapshot(3, [entry(keys, 'f4', 'a', 'created'), entry(keys, 'f1', undefined, 'deleted')]),
    snapshot(4, [entry(keys, 'f5', 'e', 'created')]),
  ];
}

export const BLOBS = ['a', 'b', 'b2', 'c', 'e', 'v'] as const;

/** The row a backup writes for an entry, and one for an older version of f2. */
function rows_of(manifest: Manifest, keys: DriveStorageKeys): DriveFileVersionIndexView[] {
  const indexes = manifest.entries.filter(records_file_content).map((e) => ({
    file_id: e.file_id,
    versions: [row(manifest.snapshot_id, e.storage_key)],
  }));
  if (manifest.snapshot_id === snapshot_id(1)) {
    indexes.push({
      file_id: 'f2-history',
      versions: [row(snapshot_id(1), keys.data_key(OWNER, 'v'), 'v1')],
    });
  }
  return indexes;
}

function row(
  snapshot: string,
  storage_key: string | undefined,
  version_id?: string,
): DriveFileVersionRecord {
  return {
    snapshot_id: snapshot,
    backup_at: '2026-01-01T00:00:00.000Z',
    drive_id: 'drive-1',
    file_name: 'x',
    parent_path: '/',
    size_bytes: 10,
    change_type: 'created',
    ...(storage_key !== undefined && { storage_key }),
    ...(version_id !== undefined && { version_id }),
  };
}

/**
 * A bucket holding the history, its run indexes, entry parts, blobs and a cursor bound to run 4.
 * Runs named in `retention`, by day, record that Object Lock policy, and a running one locks what
 * the run wrote, as the backend would.
 */
export async function seeded_bucket(
  workload: Workload,
  retention: Readonly<Record<number, SeededRetention>> = {},
): Promise<InMemoryVersionedStorage> {
  const keys = keys_of(workload);
  const bucket = in_memory_versioned_storage();
  const store = manifest_store(bucket.storage, keys);
  for (const manifest of history(keys)) {
    const recorded = retention[manifest.created_at.getUTCDate()];
    await store.save(recorded ? { ...manifest, object_lock: recorded_lock(recorded) } : manifest);
    await put_json(bucket.storage, keys.run_index_key(OWNER, manifest.snapshot_id), {
      indexes: rows_of(manifest, keys),
    });
  }
  await bucket.storage.put(keys.manifest_part_key(OWNER, snapshot_id(1), 0), Buffer.from('part'));
  for (const name of BLOBS)
    await bucket.storage.put(keys.data_key(OWNER, name), Buffer.from(`content ${name}`));
  await put_json(bucket.storage, keys.delta_cursor_key(OWNER), { snapshot_id: snapshot_id(4) });
  for (const [day_number, recorded] of Object.entries(retention)) {
    if (recorded !== 'running') continue;
    const id = snapshot_id(Number(day_number));
    const manifest = history(keys).find((m) => m.snapshot_id === id)!;
    const written = [
      keys.manifest_key(OWNER, id),
      keys.run_index_key(OWNER, id),
      ...(await bucket.storage.list(keys.manifest_snapshot_parts_prefix(OWNER, id))),
      ...manifest.entries.flatMap((e) => (e.storage_key === undefined ? [] : [e.storage_key])),
    ];
    lock_versions(bucket, written);
  }
  return bucket;
}

/** How a seeded snapshot was written: without retention, under one still running, or one ended. */
export type SeededRetention = 'running' | 'ended';

/** The Object Lock policy a run records on its manifest, ending a day after or before `now`. */
export function recorded_lock(retention: SeededRetention, now = Date.now()) {
  const retain_until = new Date(now + (retention === 'running' ? 1 : -1) * 86_400_000);
  return {
    requested: { mode: 'GOVERNANCE' as const, retention_days: 30 },
    effective: { mode: 'GOVERNANCE' as const, retain_until: retain_until.toISOString() },
  };
}

/** Makes the backend refuse to delete every current version of `keys`, as a running lock does. */
export function lock_versions(bucket: InMemoryVersionedStorage, keys: readonly string[]): void {
  for (const key of keys) {
    for (const version of bucket.versions(key)) {
      bucket.lock(version.version_id, new ObjectLockRetainedError(key));
    }
  }
}

async function put_json(storage: ObjectStorage, key: string, value: unknown): Promise<void> {
  await storage.put(key, Buffer.from(JSON.stringify(value)));
}

function manifest_store(storage: ObjectStorage, keys: DriveStorageKeys) {
  return in_memory_snapshot_store<Manifest>(
    storage,
    (manifest) => keys.manifest_key(OWNER, manifest.snapshot_id),
    (key) => new UnreadableObjectsError('damaged', [key]),
  );
}

async function read_index(
  storage: ObjectStorage,
  key: string,
): Promise<DriveFileVersionIndexView[] | undefined> {
  if (!(await storage.exists(key))) return undefined;
  try {
    return (
      JSON.parse((await storage.get(key)).toString()) as { indexes: DriveFileVersionIndexView[] }
    ).indexes;
  } catch {
    throw new UnreadableObjectsError('damaged index', [key]);
  }
}

/** The owner as the OneDrive or SharePoint service hands it to the prune, over `storage`. */
export function prune_owner(
  storage: ObjectStorage,
  workload: Workload,
): DrivePruneOwner<Manifest> & {
  readonly forgotten: string[];
} {
  const keys = keys_of(workload);
  const store = manifest_store(storage, keys);
  const forgotten: string[] = [];
  return {
    forgotten,
    label: workload,
    ctx: { tenant_id: 'tenant-test', storage } as unknown as TenantContext,
    keys,
    owner_id: OWNER,
    list_summaries: () => store.list_summaries(keys.manifest_prefix_for(OWNER)),
    read_manifest: (key) => store.read(key),
    replace_with_baseline: (manifest) => store.save(manifest),
    forget_rows: async (ids) => {
      forgotten.push(...ids);
    },
    list_indexes: () => merged_indexes(storage, keys),
    read_index_object: (key) => read_index(storage, key),
    replace_run_index: (id, indexes) =>
      put_json(storage, keys.run_index_key(OWNER, id), { indexes }),
  };
}

/** Every file's rows across the index objects, naming the ones that cannot be read. */
async function merged_indexes(storage: ObjectStorage, keys: DriveStorageKeys) {
  const by_file = new Map<string, DriveFileVersionRecord[]>();
  const unreadable_keys: string[] = [];
  for (const key of await storage.list(keys.index_prefix_for(OWNER))) {
    let indexes: DriveFileVersionIndexView[] = [];
    try {
      indexes = (await read_index(storage, key)) ?? [];
    } catch {
      unreadable_keys.push(key);
    }
    for (const index of indexes) {
      by_file.set(index.file_id, [...(by_file.get(index.file_id) ?? []), ...index.versions]);
    }
  }
  const indexes = [...by_file].map(([file_id, versions]) => ({ file_id, versions }));
  return { indexes, unreadable_keys };
}

/** Runs one prune of the owner over `storage` under a held lease. */
export function prune(
  storage: ObjectStorage,
  workload: Workload,
  options: Partial<SnapshotPruneOptions> = {},
  lease: HeldOwnerLease = stub_held_owner_lease(),
) {
  const target = drive_prune_target(prune_owner(storage, workload));
  return prune_owner_snapshots(target, lease, { before: day(3), ...options });
}

/**
 * What a snapshot restores and verifies: each live file of its folded chain with its blob's bytes,
 * and whether the version index holds the row verification looks for under the snapshot that
 * recorded the entry.
 */
export async function restored_view(storage: ObjectStorage, workload: Workload, snapshot: string) {
  const owner = prune_owner(storage, workload);
  const listing = await owner.list_summaries();
  const manifests = [];
  for (const summary of listing.summaries)
    manifests.push((await owner.read_manifest(summary.manifest_key))!);
  const target = manifests.find((m) => m.snapshot_id === snapshot)!;
  const folded = fold_drive_snapshot_chain(select_drive_manifest_chain(manifests, target));
  const indexes = await owner.list_indexes();
  const view = [];
  for (const { snapshot_id: source, entry: e } of folded) {
    if (e.change_type === 'deleted') continue;
    const rows = indexes.indexes.find((i) => i.file_id === e.file_id)?.versions ?? [];
    view.push({
      file_id: e.file_id,
      bytes: (await storage.get(e.storage_key!)).toString(),
      index_row: rows.some((r) => r.snapshot_id === source),
    });
  }
  return JSON.stringify(view.sort((a, b) => a.file_id.localeCompare(b.file_id)));
}

export async function current_state(bucket: InMemoryVersionedStorage): Promise<string> {
  const keys = await bucket.storage.list('');
  return JSON.stringify(
    await Promise.all(keys.map(async (key) => [key, (await bucket.storage.get(key)).toString()])),
  );
}

export async function bucket_state(bucket: InMemoryVersionedStorage): Promise<string> {
  const keys = await bucket.storage.list('');
  return JSON.stringify(
    keys.map((key) => [key, bucket.versions(key).map((v) => v.body.toString())]),
  );
}

export { manifest_store };
