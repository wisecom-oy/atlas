import type { TenantContext } from '@wisecom/atlas-types';
import { UnreadableContentError } from '@wisecom/atlas-types';
import { load_encrypted_json_bound_to_key } from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  owner_named_by,
  require_cursor_item_parts,
  type DriveCursorLayout,
} from '@/shared/cursor-part-document';

/** The cursor objects an owning segment has in storage, by form. */
export interface StoredCursorObjects {
  /** `delta.json`, when it exists. */
  readonly single_keys: readonly string[];
  /** `delta/head.json`, when it exists. */
  readonly head_keys: readonly string[];
  /** Every object under `delta/parts/`, referenced or not. */
  readonly part_keys: readonly string[];
}

/** Lists both cursor forms with one listing of the owning segment's `delta` prefix. */
export async function list_stored_cursor_objects(
  ctx: TenantContext,
  layout: DriveCursorLayout,
  owner_id: string,
): Promise<StoredCursorObjects> {
  const single_key = layout.keys.delta_cursor_key(owner_id);
  const parts_prefix = layout.keys.delta_cursor_parts_prefix(owner_id);
  const head_key = layout.keys.delta_cursor_head_key(owner_id);
  const keys = await ctx.storage.list(single_key.slice(0, -'.json'.length));
  return {
    single_keys: keys.filter((key) => key === single_key),
    head_keys: keys.filter((key) => key === head_key),
    part_keys: keys.filter((key) => key.startsWith(`${parts_prefix}parts/`)),
  };
}

/** What a save may keep from the current head: its stored part names and its bucket count. */
export interface ReusableCursorParts {
  readonly names: ReadonlySet<string>;
  readonly bucket_count: number | undefined;
}

const NOTHING_REUSABLE: ReusableCursorParts = { names: new Set(), bucket_count: undefined };

/**
 * Reads the current head and returns the parts it lists that are still stored. Only those are
 * reused: each was read back when written, while a part no head lists may be left from an
 * interrupted save. A damaged head reuses nothing, so every part is written again.
 */
export async function read_reusable_cursor_parts(
  ctx: TenantContext,
  layout: DriveCursorLayout,
  owner_id: string,
  stored: StoredCursorObjects,
): Promise<ReusableCursorParts> {
  if (stored.head_keys.length === 0) return NOTHING_REUSABLE;
  const head_key = layout.keys.delta_cursor_head_key(owner_id);
  try {
    const head = await load_encrypted_json_bound_to_key<Record<string, unknown>>(
      ctx,
      head_key,
      (body) => layout.keys.delta_cursor_head_key(owner_named_by(body, layout.owner_field) ?? ''),
    );
    if (head === undefined) return NOTHING_REUSABLE;
    const item_parts = require_cursor_item_parts(head.item_parts, head_key);
    const stored_parts = new Set(stored.part_keys);
    const names = item_parts.parts.filter((name) =>
      stored_parts.has(layout.keys.delta_cursor_part_key(owner_id, name)),
    );
    return { names: new Set(names), bucket_count: item_parts.bucket_count };
  } catch (err) {
    if (!(err instanceof UnreadableContentError)) throw err;
    logger.warn(`Rewriting every ${layout.label} part: ${err.message}`);
    return NOTHING_REUSABLE;
  }
}

/**
 * Deletes cursor objects in the order given, logging instead of failing: the cursor itself is
 * already stored, and the next save lists and removes whatever is left. The caller passes a head
 * before its parts, so a failure part way leaves parts nothing references rather than a head
 * missing its parts.
 */
export async function remove_cursor_objects(
  ctx: TenantContext,
  layout: DriveCursorLayout,
  keys: readonly string[],
): Promise<void> {
  try {
    for (const key of keys) await ctx.storage.delete(key);
  } catch (err) {
    logger.warn(
      `Could not remove a replaced ${layout.label} object; the next backup retries: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
