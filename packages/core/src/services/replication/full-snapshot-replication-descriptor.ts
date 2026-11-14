import type {
  CalendarSnapshotManifest,
  ContactsSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import { normalize_owner_id } from '@/services/shared/identifier-normalization';

/** The mailbox workloads whose every snapshot is a full, self-contained view. */
export type FullSnapshotWorkload = 'contacts' | 'calendar';

/** The fields replication reads from a contacts or calendar manifest. */
export interface FullSnapshotReplicaManifest {
  readonly mailbox_id: string;
  readonly snapshot_id: string;
  readonly created_at: string;
  readonly total_size_bytes: number;
}

/**
 * The whole difference between replicating a contacts snapshot and a calendar one: where the
 * manifests live and which manifest fields name stored objects. The delta cursor and the summary
 * index under `<workload>/_meta/` are not copied. The summary index is rebuilt from the manifests
 * by its reader, and a backup without a cursor enumerates the mailbox in full, as Outlook does
 * after a recovery.
 */
export interface FullSnapshotReplicationDescriptor<TManifest extends FullSnapshotReplicaManifest> {
  readonly workload: FullSnapshotWorkload;
  /** Root under which every mailbox's manifests are stored, without a trailing slash. */
  readonly manifest_root: string;
  /** Every stored object a manifest references, each once. */
  readonly object_keys: (manifest: TManifest) => string[];
  /** Reads the manifest stored at a key; raises `UnreadableContentError` when it is damaged. */
  readonly read_manifest_at: (ctx: TenantContext, key: string) => Promise<TManifest | undefined>;
}

/** The manifest reader a descriptor is built from: the workload's manifest repository port. */
export interface FullSnapshotManifestReader<TManifest> {
  read_manifest_at(ctx: TenantContext, storage_key: string): Promise<TManifest | undefined>;
}

// The layouts live in core beside the replication code, as the drive descriptors do. The contacts
// and calendar packages depend on core, so core cannot import their key builders; a test in each
// package pins these keys to the ones its backup writes.

/** How contacts plug into replication: contact JSON and photo objects under `contacts/`. */
export function contacts_replication(
  reader: FullSnapshotManifestReader<ContactsSnapshotManifest>,
): FullSnapshotReplicationDescriptor<ContactsSnapshotManifest> {
  return {
    workload: 'contacts',
    manifest_root: 'contacts/manifests',
    object_keys: (manifest) =>
      unique_keys(
        manifest.entries.flatMap((entry) => [entry.storage_key, entry.photo_storage_key]),
      ),
    read_manifest_at: (ctx, key) => reader.read_manifest_at(ctx, key),
  };
}

/** How calendars plug into replication: event JSON and attachment objects under `calendar/`. */
export function calendar_replication(
  reader: FullSnapshotManifestReader<CalendarSnapshotManifest>,
): FullSnapshotReplicationDescriptor<CalendarSnapshotManifest> {
  return {
    workload: 'calendar',
    manifest_root: 'calendar/manifests',
    object_keys: (manifest) =>
      unique_keys(
        manifest.entries.flatMap((entry) => [
          entry.storage_key,
          ...(entry.attachments ?? []).map((attachment) => attachment.storage_key),
        ]),
      ),
    read_manifest_at: (ctx, key) => reader.read_manifest_at(ctx, key),
  };
}

/** Prefix holding one mailbox's manifests of a workload. */
export function full_snapshot_mailbox_prefix(
  descriptor: { readonly manifest_root: string },
  mailbox_id: string,
): string {
  return `${descriptor.manifest_root}/${normalize_owner_id(mailbox_id)}/`;
}

/** Storage key of one snapshot's manifest, as the workload's backup writes it. */
export function full_snapshot_manifest_key(
  descriptor: { readonly manifest_root: string },
  mailbox_id: string,
  snapshot_id: string,
): string {
  return `${full_snapshot_mailbox_prefix(descriptor, mailbox_id)}${snapshot_id}.json`;
}

/** The keys in first-seen order, without absent values or repeats. */
function unique_keys(keys: ReadonlyArray<string | undefined>): string[] {
  return [...new Set(keys.filter((key): key is string => typeof key === 'string' && key !== ''))];
}
