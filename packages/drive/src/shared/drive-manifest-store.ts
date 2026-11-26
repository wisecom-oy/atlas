import type { ReadableManifestListing, TenantContext } from '@wisecom/atlas-types';
import {
  read_each_readable,
  require_every_object_readable,
  type ReadableObjects,
} from '@wisecom/atlas-core/services/shared/readable-object-listing';
import { read_encrypted_json } from '@wisecom/atlas-core/services/shared/stored-json-reader';
import {
  require_drive_manifest,
  require_drive_manifest_document,
  type DriveManifestLayout,
  type DriveStoredManifest,
} from '@/shared/drive-manifest-document';
import { read_manifest_entry_parts } from '@/shared/manifest-part-reader';
import { sweep_orphan_manifest_parts } from '@/shared/manifest-part-sweep';
import {
  DEFAULT_MANIFEST_SIZING,
  write_drive_manifest_document,
  type DriveWritableManifest,
  type ManifestSizing,
} from '@/shared/manifest-part-writer';

export type { DriveManifestLayout, DriveStoredManifest };
export { require_drive_manifest };

const MANIFEST_READ_CONCURRENCY = 8;

/**
 * Encrypts and uploads a manifest under the key its owner and snapshot name. The write is
 * create-only, refused when a reader would reject the body, and read back once it lands. A
 * manifest too large for one document is written as entry parts plus a head (#920); see
 * `write_drive_manifest_document`. The provider's repository records it in the owner's summary
 * index afterwards, only once this has resolved (#625).
 */
export async function save_drive_manifest(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  owner_id: string,
  manifest: DriveStoredManifest,
  sizing: ManifestSizing = DEFAULT_MANIFEST_SIZING,
): Promise<void> {
  await write_drive_manifest_document(
    ctx,
    layout,
    owner_id,
    manifest as DriveWritableManifest,
    sizing,
  );
  await sweep_orphan_manifest_parts(ctx, layout, owner_id);
}

/**
 * Downloads one manifest, rejecting a body that is not the identity the key names. `undefined`
 * means the object is absent.
 *
 * A manifest is encrypted with the tenant key and nothing in the ciphertext says which manifest
 * it is, so any manifest in the tenant authenticates at any other manifest's key. Rebuilding the
 * key from the decrypted body and comparing it to the key that was read is what distinguishes
 * them (issue #340). A body that fails that, or fails to decrypt, parse or carry a valid
 * `created_at`, raises `UnreadableContentError`, which a listing skips and names (issue #631).
 */
export async function read_drive_manifest<T extends DriveStoredManifest>(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  key: string,
): Promise<T | undefined> {
  const parsed = await read_encrypted_json(ctx, key, `${layout.label} manifest`);
  if (parsed === undefined) return undefined;
  const document = require_drive_manifest_document(layout, parsed, key);
  if ('entries' in document) return require_drive_manifest<T>(layout, document.body, key);
  const { entry_parts: _parts, ...head_fields } = document.body;
  const entries = await read_manifest_entry_parts(
    ctx,
    layout,
    {
      head_key: key,
      owner_id: String(document.body[layout.owner_field]),
      snapshot_id: String(document.body.snapshot_id),
    },
    document.entry_parts,
  );
  return require_drive_manifest<T>(layout, { ...head_fields, entries }, key);
}

/** Reads the manifests at `keys`, newest first, naming each damaged one and keeping its error. */
export async function read_drive_manifests<T extends DriveStoredManifest>(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  keys: readonly string[],
): Promise<ReadableObjects<T>> {
  const listing = await read_each_readable(
    keys,
    (key) => read_drive_manifest<T>(ctx, layout, key),
    MANIFEST_READ_CONCURRENCY,
  );
  return { ...listing, items: newest_first(listing.items) };
}

/** Reads one owning segment's manifests, newest first, naming each damaged one. */
export async function read_owner_drive_manifests<T extends DriveStoredManifest>(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  owner_id: string,
): Promise<ReadableObjects<T>> {
  const keys = await ctx.storage.list(layout.keys.manifest_prefix_for(owner_id));
  return read_drive_manifests<T>(ctx, layout, keys);
}

/** Presents a read as the port's listing: the readable manifests and the damaged keys. */
export function as_manifest_listing<T>(read: ReadableObjects<T>): ReadableManifestListing<T> {
  return { manifests: read.items, unreadable_keys: read.unreadable_keys };
}

/** Returns every manifest of a read, raising for a damaged one as `require_every_object_readable`. */
export function require_readable_drive_manifests<T>(
  layout: DriveManifestLayout,
  read: ReadableObjects<T>,
): T[] {
  return require_every_object_readable(read, `${layout.label} manifest(s)`);
}

function newest_first<T extends DriveStoredManifest>(manifests: T[]): T[] {
  return manifests.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}
