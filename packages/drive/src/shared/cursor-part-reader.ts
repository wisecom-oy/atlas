import type { TenantContext } from '@wisecom/atlas-types';
import {
  StorageError,
  UnreadableContentError,
  UnsupportedFormatVersionError,
} from '@wisecom/atlas-types';
import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
import { BoundedTaskPool } from '@/shared/bounded-task-pool';
import type { CursorItemMaps } from '@/shared/cursor-item-buckets';
import {
  owner_named_by,
  require_cursor_item_parts,
  require_cursor_part,
  type CursorItemParts,
  type DriveCursorLayout,
} from '@/shared/cursor-part-document';
import { digest_part_text } from '@/shared/manifest-part-document';

/** Parts fetched at once while a cursor is read. */
const PART_READ_CONCURRENCY = 8;

/**
 * A part the head lists is absent. A save that finished between reading the head and the part
 * removes the parts it replaced, so the caller reads the head again once before giving up.
 */
export class CursorPartMissingError extends UnreadableContentError {}

/**
 * Rebuilds a cursor from its head and parts: the head's fields, with each listed item map
 * reassembled from every bucket. Each part must decrypt, match the content name the head lists,
 * and name its owner and bucket. Raises `UnreadableContentError` otherwise, as a damaged
 * single-document cursor does.
 */
export async function assemble_cursor_from_parts<C>(
  ctx: TenantContext,
  layout: DriveCursorLayout,
  head_key: string,
  head: Record<string, unknown>,
): Promise<C> {
  const { item_parts: raw_item_parts, ...head_fields } = head;
  const item_parts = require_cursor_item_parts(raw_item_parts, head_key);
  const owner_id = owner_named_by(head, layout.owner_field) ?? '';
  const item_maps: CursorItemMaps = {};
  for (const field of item_parts.fields) item_maps[field] = {};
  const pool = new BoundedTaskPool(PART_READ_CONCURRENCY);
  for (const [bucket, part_name] of item_parts.parts.entries()) {
    await pool.add(async () => {
      const read = { owner_id, part_name, bucket };
      const maps = await read_cursor_part(ctx, layout, item_parts, read);
      merge_bucket_maps(item_maps, maps, item_parts.fields);
    });
  }
  await pool.drain();
  return { ...head_fields, ...item_maps } as C;
}

/** Reads, decrypts and checks one part, returning its item maps. */
async function read_cursor_part(
  ctx: TenantContext,
  layout: DriveCursorLayout,
  item_parts: CursorItemParts,
  read: { readonly owner_id: string; readonly part_name: string; readonly bucket: number },
): Promise<CursorItemMaps> {
  const key = layout.keys.delta_cursor_part_key(read.owner_id, read.part_name);
  const ciphertext = await fetch_cursor_part(ctx, layout, key);
  let plaintext: Buffer;
  try {
    plaintext = ctx.decrypt(ciphertext, key);
  } catch (err) {
    if (err instanceof UnsupportedFormatVersionError) throw err;
    throw new UnreadableContentError(`The ${layout.label} part at ${key} does not decrypt`, {
      cause: err,
    });
  }
  if (digest_part_text(ctx, plaintext) !== read.part_name) {
    throw new UnreadableContentError(
      `The ${layout.label} part at ${key} is not the part its name records`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf-8')) as unknown;
  } catch (err) {
    throw new UnreadableContentError(`The ${layout.label} part at ${key} does not parse`, {
      cause: err,
    });
  }
  const expected = { key, part_name: read.part_name, bucket: read.bucket };
  return require_cursor_part(parsed, layout, expected, item_parts.bucket_count).maps;
}

/** Fetches a part's ciphertext, raising `CursorPartMissingError` when it is absent. */
async function fetch_cursor_part(
  ctx: TenantContext,
  layout: DriveCursorLayout,
  key: string,
): Promise<Buffer> {
  try {
    return await ctx.storage.get(key);
  } catch (err) {
    if (is_absent_object_error(err)) {
      throw new CursorPartMissingError(`The ${layout.label} part at ${key} is missing`);
    }
    throw new StorageError(`Could not read the ${layout.label} part at ${key}`, { cause: err });
  }
}

/** Copies one bucket's slice of each listed field into the cursor's maps. */
function merge_bucket_maps(
  item_maps: CursorItemMaps,
  bucket_maps: CursorItemMaps,
  fields: readonly string[],
): void {
  for (const field of fields) {
    const slice = bucket_maps[field];
    if (slice !== undefined) Object.assign(item_maps[field]!, slice);
  }
}
