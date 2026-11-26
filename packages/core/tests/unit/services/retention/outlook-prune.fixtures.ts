import 'reflect-metadata';
import type {
  Manifest,
  ManifestEntry,
  ManifestRepository,
  ObjectStorage,
  SnapshotPruneOptions,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { ObjectLockRetainedError, UnreadableObjectsError } from '@wisecom/atlas-types';
import {
  in_memory_versioned_storage,
  type InMemoryVersionedStorage,
} from '@wisecom/atlas-types/testing/in-memory-versioned-storage';
import {
  in_memory_snapshot_store,
  type InMemorySnapshotStore,
} from '@wisecom/atlas-types/testing/in-memory-snapshot-store';
import {
  stub_owner_leases,
  type StubOwnerLeases,
} from '@wisecom/atlas-types/testing/stub-owner-leases';
import { OutlookSnapshotPruneService } from '@/services/retention/outlook-snapshot-prune.service';
import { load_snapshot_chain } from '@/services/shared/manifest-chain';
import { merge_snapshot_entries } from '@/services/shared/manifest-entry-merger';

export const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001';
export const TENANT = 'tenant-test';

/** Midnight UTC of a day in January 2026. */
export function day(n: number): Date {
  return new Date(Date.UTC(2026, 0, n));
}

export function manifest_key(snapshot_id: string): string {
  return `manifests/${OWNER}/${snapshot_id}.json`;
}

export function blob_key(name: string): string {
  return `data/${OWNER}/${name}`;
}

export function attachment_key(name: string): string {
  return `attachments/${OWNER}/${name}`;
}

export function pointer_key(snapshot_id: string): string {
  return `_meta/outlook-manifests/snapshots/${snapshot_id}.json`;
}

function entry(object_id: string, blob: string, attachment?: string): ManifestEntry {
  return {
    object_id,
    storage_key: blob_key(blob),
    checksum: `sha-${blob}`,
    size_bytes: 10,
    folder_id: 'inbox',
    ...(attachment !== undefined && {
      attachments: [
        {
          attachment_id: `att-${attachment}`,
          name: 'file.txt',
          content_type: 'text/plain',
          size_bytes: 5,
          storage_key: attachment_key(attachment),
          checksum: `sha-${attachment}`,
          is_inline: false,
        },
      ],
    }),
  };
}

function snapshot(
  snapshot_id: string,
  created_at: Date,
  entries: ManifestEntry[],
  removed_object_ids?: string[],
): Manifest {
  return {
    id: `id-${snapshot_id}`,
    tenant_id: TENANT,
    owner_id: OWNER,
    snapshot_id,
    created_at,
    total_objects: entries.length,
    total_size_bytes: entries.length * 10,
    delta_links: {},
    entries,
    ...(removed_object_ids !== undefined && { removed_object_ids }),
  };
}

/**
 * Four runs of one mailbox, one a day:
 * - s1: m1 (blob a), m2 (blob b), m3 (blob c, legacy attachment d)
 * - s2: m2 again with new content (blob b2); m3 removed
 * - s3: m4, whose content equals m1's and deduplicates to blob a; m1 removed
 * - s4: m5 (blob e)
 */
export const HISTORY: readonly Manifest[] = [
  snapshot('s1', day(1), [entry('m1', 'a'), entry('m2', 'b'), entry('m3', 'c', 'd')]),
  snapshot('s2', day(2), [entry('m2', 'b2')], ['m3']),
  snapshot('s3', day(3), [entry('m4', 'a')], ['m1']),
  snapshot('s4', day(4), [entry('m5', 'e')]),
];

export const BLOBS = ['a', 'b', 'b2', 'c', 'e'] as const;

/**
 * A versioned bucket holding the history above, its blobs, pointers and delta cursor. Snapshots
 * named in `retention` record that Object Lock policy, and a running one locks their manifest and
 * the blobs they first stored, as the backend would.
 */
export async function seeded_bucket(
  retention: Readonly<Record<string, SeededRetention>> = {},
): Promise<InMemoryVersionedStorage> {
  const bucket = in_memory_versioned_storage();
  const store = outlook_store(bucket.storage);
  for (const manifest of HISTORY) {
    const recorded = retention[manifest.snapshot_id];
    await store.save(recorded ? { ...manifest, object_lock: recorded_lock(recorded) } : manifest);
    await bucket.storage.put(
      pointer_key(manifest.snapshot_id),
      Buffer.from(manifest_key(manifest.snapshot_id)),
    );
  }
  for (const name of BLOBS)
    await bucket.storage.put(blob_key(name), Buffer.from(`content ${name}`));
  await bucket.storage.put(attachment_key('d'), Buffer.from('attachment d'));
  await bucket.storage.put(`_meta/outlook-cursors/${OWNER}.json`, Buffer.from('cursor of s4'));
  for (const [snapshot_id, recorded] of Object.entries(retention)) {
    if (recorded !== 'running') continue;
    const manifest = HISTORY.find((m) => m.snapshot_id === snapshot_id)!;
    const blobs = manifest.entries.flatMap((e) => [
      e.storage_key,
      ...(e.attachments ?? []).map((a) => a.storage_key),
    ]);
    lock_versions(bucket, [manifest_key(snapshot_id), ...blobs]);
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

export function outlook_store(storage: ObjectStorage): InMemorySnapshotStore<Manifest> {
  return in_memory_snapshot_store<Manifest>(
    storage,
    (manifest) => manifest_key(manifest.snapshot_id),
    (key) => new UnreadableObjectsError('damaged', [key]),
  );
}

/** A repository stub over the bucket: what the prune and the chain loader call. */
export function outlook_repository(storage: ObjectStorage): ManifestRepository & {
  readonly forgotten: string[];
} {
  const store = outlook_store(storage);
  const forgotten: string[] = [];
  const repository = {
    forgotten,
    list_snapshot_summaries: (_ctx: TenantContext, owner_id: string) =>
      store.list_summaries(`manifests/${owner_id}/`),
    read_manifest_at: (_ctx: TenantContext, key: string) => store.read(key),
    find_by_snapshot: (_ctx: TenantContext, snapshot_id: string) =>
      store.read(manifest_key(snapshot_id)),
    replace_with_baseline: async (_ctx: TenantContext, manifest: Manifest) => store.save(manifest),
    forget_snapshot_summaries: async (
      _ctx: TenantContext,
      _owner: string,
      ids: readonly string[],
    ) => {
      forgotten.push(...ids);
    },
  };
  return repository as unknown as ManifestRepository & { readonly forgotten: string[] };
}

function context_over(storage: ObjectStorage): TenantContext {
  return {
    tenant_id: TENANT,
    storage,
    encrypt: (data: Buffer) => data,
    decrypt: (data: Buffer) => data,
    destroy: () => undefined,
  } as unknown as TenantContext;
}

/** The prune service over `storage`, and the lease stub it takes the mailbox's lease from. */
export function prune_service(storage: ObjectStorage): {
  readonly service: OutlookSnapshotPruneService;
  readonly leases: StubOwnerLeases;
  readonly repository: ReturnType<typeof outlook_repository>;
} {
  const leases = stub_owner_leases();
  const repository = outlook_repository(storage);
  const factory = {
    create_readonly: async () => context_over(storage),
    create_storage_only: async () => context_over(storage),
  } as unknown as TenantContextFactory;
  return {
    service: new OutlookSnapshotPruneService(factory, repository, leases.leases),
    leases,
    repository,
  };
}

export function prune_options(overrides: Partial<SnapshotPruneOptions> = {}): SnapshotPruneOptions {
  return { before: day(3), ...overrides };
}

/**
 * What a snapshot restores: its merged entries, each with the bytes of every blob it names. Two
 * equal views restore and verify the same messages from the same content.
 */
export async function restored_view(storage: ObjectStorage, snapshot_id: string): Promise<string> {
  const chain = await load_snapshot_chain(
    outlook_repository(storage),
    context_over(storage),
    snapshot_id,
  );
  const merged = merge_snapshot_entries(chain).sort((a, b) =>
    a.object_id.localeCompare(b.object_id),
  );
  const view = [];
  for (const merged_entry of merged) {
    const keys = [
      merged_entry.storage_key,
      ...(merged_entry.attachments ?? []).map((a) => a.storage_key),
    ];
    const bytes = await Promise.all(keys.map(async (key) => (await storage.get(key)).toString()));
    view.push({ object_id: merged_entry.object_id, checksum: merged_entry.checksum, bytes });
  }
  return JSON.stringify(view);
}

/** Every key and the bytes of each of its versions, for comparing two bucket states. */
export async function bucket_state(bucket: InMemoryVersionedStorage): Promise<string> {
  const keys = await bucket.storage.list('');
  return JSON.stringify(
    keys.map((key) => [key, bucket.versions(key).map((v) => v.body.toString())]),
  );
}

/** The bucket's keys and the bytes of each key's current version, ignoring version history. */
export async function current_state(bucket: InMemoryVersionedStorage): Promise<string> {
  const keys = await bucket.storage.list('');
  return JSON.stringify(
    await Promise.all(keys.map(async (key) => [key, (await bucket.storage.get(key)).toString()])),
  );
}
