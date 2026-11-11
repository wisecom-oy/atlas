import type {
  LatestReadableManifest,
  ReadableManifestListing,
  TenantContext,
} from '@wisecom/atlas-types';
import { UnreadableObjectsError } from '@wisecom/atlas-types';
import {
  read_each_readable,
  require_every_object_readable,
  type ReadableObjects,
} from '@wisecom/atlas-core/services/shared/readable-object-listing';
import {
  is_json_record,
  read_encrypted_json,
} from '@wisecom/atlas-core/services/shared/stored-json-reader';
import type { DriveStorageKeys } from '@/shared/storage-keys';

/** What the store needs from either provider's manifest. */
export interface DriveStoredManifest {
  readonly snapshot_id: string;
  readonly created_at: Date;
}

/**
 * How one provider names and lays out its manifests. They differ only in the namespace and in
 * the field that names the owning segment (`owner_id` on OneDrive, `site_id` on SharePoint).
 */
export interface DriveManifestLayout {
  /** Provider name for operator-facing messages, e.g. `OneDrive`. */
  readonly label: string;
  readonly keys: DriveStorageKeys;
  readonly owner_field: 'owner_id' | 'site_id';
}

const MANIFEST_READ_CONCURRENCY = 8;

/** Encrypts and uploads a manifest under the key its owner and snapshot name. */
export async function save_drive_manifest(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  owner_id: string,
  manifest: DriveStoredManifest,
): Promise<void> {
  const key = layout.keys.manifest_key(owner_id, manifest.snapshot_id);
  await ctx.storage.put(key, ctx.encrypt(Buffer.from(JSON.stringify(manifest)), key));
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
  const label = `${layout.label} manifest`;
  const parsed = await read_encrypted_json(ctx, key, label);
  if (parsed === undefined) return undefined;
  if (!is_json_record(parsed) || !Array.isArray(parsed.entries)) {
    throw new UnreadableObjectsError(`The ${label} is not a manifest`, [key]);
  }
  if (rebuilt_key(layout, parsed) !== key) {
    const named = `${String(parsed[layout.owner_field])}/${String(parsed.snapshot_id)}`;
    throw new UnreadableObjectsError(
      `The ${label} decrypts to ${named}; ` +
        `refusing to use a manifest that is not the one the key names`,
      [key],
    );
  }
  const created_at = new Date(parsed.created_at as string);
  if (typeof parsed.created_at !== 'string' || Number.isNaN(created_at.getTime())) {
    throw new UnreadableObjectsError(`Invalid created_at in the ${label}`, [key]);
  }
  return { ...(parsed as unknown as T), created_at };
}

/** The key a parsed body claims to live under; undefined when its identity fields are unusable. */
function rebuilt_key(
  layout: DriveManifestLayout,
  body: Record<string, unknown>,
): string | undefined {
  const owner = body[layout.owner_field];
  if (typeof owner !== 'string' || typeof body.snapshot_id !== 'string') return undefined;
  try {
    return layout.keys.manifest_key(owner, body.snapshot_id);
  } catch {
    return undefined;
  }
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

/** Returns the newest readable manifest of an owning segment, naming every damaged one. */
export async function find_latest_readable_drive_manifest<T extends DriveStoredManifest>(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  owner_id: string,
): Promise<LatestReadableManifest<T>> {
  const read = await read_owner_drive_manifests<T>(ctx, layout, owner_id);
  return { manifest: read.items.at(0), unreadable_keys: read.unreadable_keys };
}

/** Returns every manifest of a read, raising for a damaged one as `require_every_object_readable`. */
export function require_readable_drive_manifests<T>(
  layout: DriveManifestLayout,
  read: ReadableObjects<T>,
): T[] {
  return require_every_object_readable(read, ` manifest(s)`);
}

function newest_first<T extends DriveStoredManifest>(manifests: T[]): T[] {
  return manifests.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}
