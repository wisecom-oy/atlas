import type { TenantContext } from '@wisecom/atlas-types';
import {
  StorageError,
  UnreadableObjectsError,
  UnsupportedFormatVersionError,
} from '@wisecom/atlas-types';
import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
import { BoundedTaskPool } from '@/shared/bounded-task-pool';
import type { DriveManifestLayout } from '@/shared/drive-manifest-document';
import {
  digest_part_text,
  require_manifest_part_entries,
  type ManifestEntryParts,
  type ManifestPartReference,
} from '@/shared/manifest-part-document';

/** Parts fetched at once for one manifest. */
const PART_READ_CONCURRENCY = 4;

/** The manifest a set of parts belongs to. */
export interface ManifestPartsOwner {
  readonly head_key: string;
  readonly owner_id: string;
  readonly snapshot_id: string;
}

/**
 * Reads every entry part a manifest head lists and returns their entries in order.
 *
 * Each part must exist, decrypt, match the keyed digest the head recorded, name its own key, and
 * hold the entry count the head recorded. Any failure makes the whole manifest unreadable and is
 * raised as `UnreadableObjectsError` naming the head, which is the object a listing skips and an
 * operator quarantines. A failed fetch raises `StorageError`, since it says nothing about the part.
 */
export async function read_manifest_entry_parts(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  owner: ManifestPartsOwner,
  entry_parts: ManifestEntryParts,
): Promise<unknown[]> {
  const slots = new Array<unknown[]>(entry_parts.parts.length);
  const pool = new BoundedTaskPool(PART_READ_CONCURRENCY);
  for (const [part_index, reference] of entry_parts.parts.entries()) {
    await pool.add(async () => {
      slots[part_index] = await read_entry_part(ctx, layout, owner, part_index, reference);
    });
  }
  await pool.drain();
  return flatten_in_order(slots);
}

/** Reads, decrypts and checks one part, returning its entries. */
async function read_entry_part(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  owner: ManifestPartsOwner,
  part_index: number,
  reference: ManifestPartReference,
): Promise<unknown[]> {
  const part_key = layout.keys.manifest_part_key(owner.owner_id, owner.snapshot_id, part_index);
  const damaged = (reason: string, cause?: unknown): UnreadableObjectsError =>
    new UnreadableObjectsError(
      `The ${layout.label} manifest's entry part ${part_key} ${reason}`,
      [owner.head_key],
      { cause },
    );
  const ciphertext = await fetch_part(ctx, layout, part_key);
  if (ciphertext === undefined) throw damaged('is missing');
  let plaintext: Buffer;
  try {
    plaintext = ctx.decrypt(ciphertext, part_key);
  } catch (err) {
    if (err instanceof UnsupportedFormatVersionError) throw err;
    throw damaged('does not decrypt', err);
  }
  if (digest_part_text(ctx, plaintext) !== reference.digest) {
    throw damaged('is not the part the manifest head recorded');
  }
  const entries = parse_part_entries(layout, plaintext, part_key, damaged);
  if (entries.length !== reference.entry_count) {
    throw damaged(
      `holds ${entries.length} entries where the head recorded ${reference.entry_count}`,
    );
  }
  return entries;
}

/** Fetches a part's ciphertext; undefined when it is absent. */
async function fetch_part(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  part_key: string,
): Promise<Buffer | undefined> {
  try {
    return await ctx.storage.get(part_key);
  } catch (err) {
    if (is_absent_object_error(err)) return undefined;
    throw new StorageError(`Could not read the ${layout.label} manifest part at ${part_key}`, {
      cause: err,
    });
  }
}

/** Parses a part's plaintext and checks that it names its own key. */
function parse_part_entries(
  layout: DriveManifestLayout,
  plaintext: Buffer,
  part_key: string,
  damaged: (reason: string, cause?: unknown) => UnreadableObjectsError,
): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf-8')) as unknown;
  } catch (err) {
    throw damaged('does not parse', err);
  }
  try {
    return require_manifest_part_entries(
      parsed,
      layout.owner_field,
      layout.keys.manifest_part_key,
      part_key,
    );
  } catch (err) {
    throw damaged('names another snapshot or position than its key', err);
  }
}

/** Joins the parts' entries in part order without spreading a large array onto the stack. */
function flatten_in_order(slots: readonly unknown[][]): unknown[] {
  const entries: unknown[] = [];
  for (const slot of slots) {
    for (const entry of slot) entries.push(entry);
  }
  return entries;
}
