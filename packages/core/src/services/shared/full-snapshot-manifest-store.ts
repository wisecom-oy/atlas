import type {
  LatestReadableManifest,
  ReadableManifestListing,
  TenantContext,
} from '@wisecom/atlas-types';
import { UnreadableObjectsError } from '@wisecom/atlas-types';
import { read_each_readable } from '@/services/shared/readable-object-listing';
import { append_all } from '@/utils/append-all';
import { is_json_record, read_encrypted_json } from '@/services/shared/stored-json-reader';
import { write_encrypted_json } from '@/services/shared/stored-json-writer';

/** The fields every full snapshot manifest carries, whichever mailbox workload wrote it. */
export interface FullSnapshotManifest {
  readonly mailbox_id: string;
  readonly snapshot_id: string;
  readonly created_at: string;
}

/**
 * How one mailbox workload lays out and shapes its full snapshot manifests. Contacts and Calendar
 * differ only in names: the key layout, the snapshot id prefix, and the field naming an entry.
 */
export interface FullSnapshotManifestLayout {
  /** Operator-facing name, e.g. `contacts manifest`. */
  readonly label: string;
  readonly manifest_key: (mailbox_id: string, snapshot_id: string) => string;
  readonly manifest_prefix: (mailbox_id: string) => string;
  /** Snapshot id prefix before the epoch milliseconds, e.g. `ct-snap-`. */
  readonly snapshot_id_prefix: string;
  /** Array fields besides `entries` the manifest always has, e.g. `folders`. */
  readonly list_fields: readonly string[];
  /** Field naming an entry's source item, e.g. `contact_id`. */
  readonly entry_id_field: string;
}

/**
 * Reads, decrypts and validates one manifest; `undefined` only when the object is absent.
 *
 * The parsed body is checked before anything trusts it: a manifest is the only record of which
 * objects a snapshot holds, so a body with the wrong shape, another mailbox or snapshot, or an
 * unreadable `created_at` raises `UnreadableContentError` like ciphertext that fails to decrypt.
 * A listing skips it and names the key; a read of that one snapshot fails (issue #631).
 */
export async function read_full_snapshot_manifest<T extends FullSnapshotManifest>(
  ctx: TenantContext,
  layout: FullSnapshotManifestLayout,
  key: string,
): Promise<T | undefined> {
  const parsed = await read_encrypted_json(ctx, key, layout.label);
  if (parsed === undefined) return undefined;
  return require_full_snapshot_manifest<T>(layout, parsed, key);
}

/**
 * Encrypts and stores one manifest under the key its mailbox and snapshot name. The write is
 * create-only, refused when {@link require_full_snapshot_manifest} would reject the body, and read
 * back once it lands.
 */
export async function save_full_snapshot_manifest(
  ctx: TenantContext,
  layout: FullSnapshotManifestLayout,
  manifest: FullSnapshotManifest,
): Promise<void> {
  await write_encrypted_json(
    ctx,
    {
      key: layout.manifest_key(manifest.mailbox_id, manifest.snapshot_id),
      label: layout.label,
      reader_check: (parsed, key) => require_full_snapshot_manifest(layout, parsed, key),
      write: 'create_only',
      confirm_read_back: true,
    },
    manifest,
  );
}

/** The shape, identity and date checks of a parsed manifest body, shared by reader and writer. */
export function require_full_snapshot_manifest<T extends FullSnapshotManifest>(
  layout: FullSnapshotManifestLayout,
  parsed: unknown,
  key: string,
): T {
  if (!has_manifest_shape(layout, parsed)) {
    throw new UnreadableObjectsError(`The ${layout.label} is not a manifest`, [key]);
  }
  if (rebuilt_key(layout, parsed) !== key) {
    throw new UnreadableObjectsError(
      `The ${layout.label} names a different mailbox or snapshot than its key`,
      [key],
    );
  }
  if (Number.isNaN(Date.parse(parsed.created_at))) {
    throw new UnreadableObjectsError(`The ${layout.label} has an invalid created_at`, [key]);
  }
  return parsed as unknown as T;
}

/**
 * Returns the newest readable manifest of a mailbox. Keys are tried newest first by the epoch in
 * the snapshot id, and the first readable one ends the read, so only the damaged manifests newer
 * than the one returned are downloaded and named.
 */
export async function find_latest_readable_full_snapshot<T extends FullSnapshotManifest>(
  ctx: TenantContext,
  layout: FullSnapshotManifestLayout,
  mailbox_id: string,
): Promise<LatestReadableManifest<T>> {
  const keys = await manifest_keys(ctx, layout, mailbox_id);
  keys.sort((a, b) => snapshot_epoch(layout, b) - snapshot_epoch(layout, a));
  const unreadable_keys: string[] = [];
  for (const key of keys) {
    const listing = await read_each_readable([key], (k) =>
      read_full_snapshot_manifest<T>(ctx, layout, k),
    );
    if (listing.items[0] !== undefined) return { manifest: listing.items[0], unreadable_keys };
    append_all(unreadable_keys, listing.unreadable_keys);
  }
  return { manifest: undefined, unreadable_keys };
}

/** Lists a mailbox's readable manifests newest first, naming every damaged one. */
export async function list_readable_full_snapshots<T extends FullSnapshotManifest>(
  ctx: TenantContext,
  layout: FullSnapshotManifestLayout,
  mailbox_id: string,
): Promise<ReadableManifestListing<T>> {
  const keys = await manifest_keys(ctx, layout, mailbox_id);
  const listing = await read_each_readable(keys, (key) =>
    read_full_snapshot_manifest<T>(ctx, layout, key),
  );
  const manifests = listing.items.sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  );
  return { manifests, unreadable_keys: listing.unreadable_keys };
}

/** Object keys of a mailbox's manifests. */
async function manifest_keys(
  ctx: TenantContext,
  layout: FullSnapshotManifestLayout,
  mailbox_id: string,
): Promise<string[]> {
  const keys = await ctx.storage.list(layout.manifest_prefix(mailbox_id));
  return keys.filter((key) => key.endsWith('.json'));
}

/** Milliseconds embedded in a `<prefix><ms>-<hex>` id; 0 for anything else, sorting it last. */
function snapshot_epoch(layout: FullSnapshotManifestLayout, key: string): number {
  const name = key.slice(key.lastIndexOf('/') + 1);
  if (!name.startsWith(layout.snapshot_id_prefix)) return 0;
  const epoch = Number.parseInt(name.slice(layout.snapshot_id_prefix.length), 10);
  return Number.isNaN(epoch) ? 0 : epoch;
}

/** Whether a parsed body has every field a manifest of this workload is written with. */
function has_manifest_shape(
  layout: FullSnapshotManifestLayout,
  value: unknown,
): value is FullSnapshotManifest & Record<string, unknown> {
  if (!is_json_record(value)) return false;
  const identity_ok =
    typeof value.mailbox_id === 'string' &&
    typeof value.snapshot_id === 'string' &&
    typeof value.created_at === 'string';
  const lists_ok = layout.list_fields.every((field) => Array.isArray(value[field]));
  return identity_ok && lists_ok && Array.isArray(value.entries) && entries_ok(layout, value);
}

/** Every entry names its item and the stored object it was written to, with its checksum. */
function entries_ok(layout: FullSnapshotManifestLayout, value: Record<string, unknown>): boolean {
  return (value.entries as unknown[]).every(
    (entry) =>
      is_json_record(entry) &&
      typeof entry[layout.entry_id_field] === 'string' &&
      typeof entry.storage_key === 'string' &&
      typeof entry.checksum === 'string',
  );
}

/** The key a parsed body claims to live under; undefined when its identity fields are unusable. */
function rebuilt_key(
  layout: FullSnapshotManifestLayout,
  body: FullSnapshotManifest,
): string | undefined {
  try {
    return layout.manifest_key(body.mailbox_id, body.snapshot_id);
  } catch {
    return undefined;
  }
}
