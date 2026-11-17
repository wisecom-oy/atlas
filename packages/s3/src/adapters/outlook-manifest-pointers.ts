import type { Manifest, TenantContext } from '@wisecom/atlas-types';
import { StorageError } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
import { write_encrypted_json } from '@wisecom/atlas-core/services/shared/stored-json-writer';
import { OUTLOOK_MANIFEST_PREFIX } from '@/adapters/outlook-manifest-reader';
import { OUTLOOK_MANIFEST_POINTER_PREFIX as MANIFEST_POINTER_PREFIX } from '@/adapters/outlook-snapshot-summary-layout';

/**
 * The body of a pointer object. `created_at` is written by the latest pointer since issue #741;
 * a pointer without it, such as one an older release wrote, names only its manifest.
 */
export interface ManifestPointer {
  readonly manifest_key: string;
  readonly created_at?: string;
}

/** The snapshot a latest pointer names when that snapshot is newer than the one being written. */
export interface NewerLatestPointer {
  readonly snapshot_id: string;
  readonly created_at: Date;
}

/** Key of a mailbox's `latest.json` pointer. */
export function latest_pointer_key(owner_id: string): string {
  return `${MANIFEST_POINTER_PREFIX}/owners/${owner_id}/latest.json`;
}

/** Key of the pointer from one snapshot ID to its manifest. */
export function snapshot_pointer_key(snapshot_id: string): string {
  return `${MANIFEST_POINTER_PREFIX}/snapshots/${snapshot_id}.json`;
}

/**
 * Reads the latest pointer for a status or backup. An absent or unreadable pointer resolves
 * `undefined`, so the caller scans the owner's manifests. A failed fetch raises `StorageError`:
 * a transient error must fail the read, not turn into a damage scan that reports exit 9.
 */
export async function read_latest_pointer(
  ctx: TenantContext,
  key: string,
): Promise<string | undefined> {
  let encrypted: Buffer;
  try {
    encrypted = await ctx.storage.get(key);
  } catch (err) {
    if (is_absent_object_error(err)) return undefined;
    throw new StorageError(`Could not read the Outlook manifest pointer at ${key}`, { cause: err });
  }
  try {
    return pointer_manifest_key(JSON.parse(ctx.decrypt(encrypted, key).toString('utf-8')));
  } catch {
    return undefined;
  }
}

/** The manifest key a parsed pointer body names. Throws for `null`; undefined when it names none. */
export function pointer_manifest_key(parsed: unknown): string | undefined {
  const pointer = parsed as Partial<ManifestPointer>;
  return typeof pointer.manifest_key === 'string' ? pointer.manifest_key : undefined;
}

/**
 * Stores one pointer, overwriting any previous one. A pointer is a shortcut: every read that finds
 * it missing or unusable falls back to listing the manifests, so it is not read back.
 */
export async function write_manifest_pointer(
  ctx: TenantContext,
  key: string,
  pointer: ManifestPointer,
): Promise<void> {
  await write_encrypted_json(
    ctx,
    {
      key,
      label: 'Outlook manifest pointer',
      reader_check: require_pointer_names_manifest,
      write: 'overwrite',
      confirm_read_back: false,
    },
    pointer,
  );
}

/**
 * Points `latest.json` at a manifest unless the pointer already names a snapshot created after it
 * (issue #741). A slower run that finishes last would otherwise point latest at an older snapshot.
 * Equal times replace, as they always did. A missing, unreadable or pre-#741 pointer is replaced.
 */
export async function write_latest_pointer_unless_newer(
  ctx: TenantContext,
  manifest: Manifest,
  manifest_key: string,
): Promise<void> {
  const current = await read_current_latest_pointer(ctx, manifest.owner_id);
  const newer = find_newer_latest_pointer(current, manifest);
  if (newer) {
    warn_latest_pointer_kept(newer, manifest);
    return;
  }
  await write_manifest_pointer(ctx, latest_pointer_key(manifest.owner_id), {
    manifest_key,
    created_at: manifest.created_at.toISOString(),
  });
}

/**
 * The snapshot the current latest pointer names, when that snapshot is strictly newer than the
 * manifest being written. Undefined when the pointer is absent, has no `created_at`, names a
 * manifest of another owner, or is not newer. Pure, so the comparison needs no storage.
 */
export function find_newer_latest_pointer(
  current: ManifestPointer | undefined,
  manifest: Manifest,
): NewerLatestPointer | undefined {
  if (typeof current?.created_at !== 'string') return undefined;
  const pointed_at = new Date(current.created_at);
  if (Number.isNaN(pointed_at.getTime())) return undefined;
  if (pointed_at.getTime() <= manifest.created_at.getTime()) return undefined;
  const snapshot_id = snapshot_id_of_manifest_key(current.manifest_key, manifest.owner_id);
  if (snapshot_id === undefined) return undefined;
  return { snapshot_id, created_at: pointed_at };
}

/** Reads the latest pointer body for the write guard. Every failure resolves `undefined`. */
async function read_current_latest_pointer(
  ctx: TenantContext,
  owner_id: string,
): Promise<ManifestPointer | undefined> {
  const key = latest_pointer_key(owner_id);
  try {
    const parsed: unknown = JSON.parse(
      ctx.decrypt(await ctx.storage.get(key), key).toString('utf-8'),
    );
    return pointer_manifest_key(parsed) === undefined ? undefined : (parsed as ManifestPointer);
  } catch (err) {
    if (!is_absent_object_error(err)) {
      logger.warn('The Outlook latest pointer could not be read for comparison and is replaced.');
    }
    return undefined;
  }
}

/** The snapshot ID a manifest key of this owner names; undefined for any other key shape. */
function snapshot_id_of_manifest_key(manifest_key: string, owner_id: string): string | undefined {
  const prefix = `${OUTLOOK_MANIFEST_PREFIX}/${owner_id}/`;
  if (!manifest_key.startsWith(prefix) || !manifest_key.endsWith('.json')) return undefined;
  const snapshot_id = manifest_key.slice(prefix.length, -'.json'.length);
  return snapshot_id.length > 0 && !snapshot_id.includes('/') ? snapshot_id : undefined;
}

function warn_latest_pointer_kept(newer: NewerLatestPointer, manifest: Manifest): void {
  logger.warn(
    `Kept the Outlook latest pointer at snapshot ${newer.snapshot_id}, which was created at ` +
      `${newer.created_at.toISOString()}. Snapshot ${manifest.snapshot_id}, created at ` +
      `${manifest.created_at.toISOString()}, is stored but was not made the latest.`,
  );
}

/** Raises unless the pointer readers would get a manifest key out of the parsed body. */
function require_pointer_names_manifest(parsed: unknown): void {
  if (pointer_manifest_key(parsed) === undefined) {
    throw new Error('the pointer names no manifest key');
  }
}
