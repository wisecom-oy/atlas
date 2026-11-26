import type { TenantContext } from '@wisecom/atlas-types';
import {
  load_encrypted_json_bound_to_key,
  state_names_key_check,
} from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import { write_encrypted_json } from '@wisecom/atlas-core/services/shared/stored-json-writer';
import { UNLOCKED_STATE_WRITE } from '@wisecom/atlas-core/services/shared/run-object-lock';
import {
  choose_bucket_count,
  count_tracked_items,
  split_cursor_fields,
} from '@/shared/cursor-item-buckets';
import { owner_named_by, type DriveCursorLayout } from '@/shared/cursor-part-document';
import { assemble_cursor_from_parts, CursorPartMissingError } from '@/shared/cursor-part-reader';
import { write_cursor_head, write_cursor_parts } from '@/shared/cursor-part-writer';
import { remove_replaced_cursor_objects } from '@/shared/replaced-cursor-objects';
import {
  list_stored_cursor_objects,
  read_reusable_cursor_parts,
} from '@/shared/stored-cursor-objects';

export type { DriveCursorLayout };

/** When a cursor is split into parts, and how the parts are written. */
export interface CursorSizing {
  /** A cursor tracking at most this many items stays one document, which every Atlas reads. */
  readonly single_document_items: number;
  /** The items one part aims to hold. */
  readonly items_per_part: number;
  /** Parts uploaded at once. */
  readonly write_concurrency: number;
}

/** The sizing every backup uses; tests pass smaller values to cross the threshold cheaply. */
export const DEFAULT_CURSOR_SIZING: CursorSizing = Object.freeze({
  single_document_items: 10_000,
  items_per_part: 2_048,
  write_concurrency: 4,
});

/**
 * Loads an owning segment's delta cursor; undefined only when none is stored. Raises
 * `UnreadableContentError` when it is damaged or names another owner.
 *
 * A cursor is either one document at `delta.json` or a head plus parts under `delta/` (#920).
 * Both exist only after an interrupted switch between the two forms, or after an older Atlas wrote
 * `delta.json` over a bucket this one had written parts to; the newer `updated_at` wins then.
 */
export async function load_drive_cursor<C extends { readonly updated_at: string }>(
  ctx: TenantContext,
  layout: DriveCursorLayout,
  owner_id: string,
): Promise<C | undefined> {
  try {
    return await load_newest_cursor_form<C>(ctx, layout, owner_id);
  } catch (err) {
    if (!(err instanceof CursorPartMissingError)) throw err;
    // A save finished between the head and a part and removed the part it replaced.
    return load_newest_cursor_form<C>(ctx, layout, owner_id);
  }
}

/** Reads both cursor forms and returns the newer, assembling a multi-part one. */
async function load_newest_cursor_form<C extends { readonly updated_at: string }>(
  ctx: TenantContext,
  layout: DriveCursorLayout,
  owner_id: string,
): Promise<C | undefined> {
  const head_key = layout.keys.delta_cursor_head_key(owner_id);
  const [head, single] = await Promise.all([
    load_encrypted_json_bound_to_key<Record<string, unknown>>(ctx, head_key, (body) =>
      layout.keys.delta_cursor_head_key(owner_named_by(body, layout.owner_field) ?? ''),
    ),
    load_encrypted_json_bound_to_key<C>(ctx, layout.keys.delta_cursor_key(owner_id), (body) =>
      layout.keys.delta_cursor_key(owner_named_by(body, layout.owner_field) ?? ''),
    ),
  ]);
  if (head === undefined) return single;
  if (single !== undefined && is_newer(single.updated_at, head.updated_at)) return single;
  return assemble_cursor_from_parts<C>(ctx, layout, head_key, head);
}

/**
 * Stores the cursor, overwriting the previous one, and reads every object it writes back.
 *
 * A cursor tracking up to `single_document_items` items is one document at `delta.json`, as every
 * earlier Atlas writes it. A larger one is a head plus one part per bucket of item ids; only the
 * parts whose content changed are written, the head goes last, and what it replaced is removed
 * afterwards (#920). All of it is run state, written without Object Lock (#919).
 */
export async function save_drive_cursor(
  ctx: TenantContext,
  layout: DriveCursorLayout,
  cursor: object,
  sizing: CursorSizing = DEFAULT_CURSOR_SIZING,
): Promise<void> {
  const owner_id = owner_named_by(cursor, layout.owner_field) ?? '';
  const stored = await list_stored_cursor_objects(ctx, layout, owner_id);
  const previous = await read_reusable_cursor_parts(ctx, layout, owner_id, stored);
  const replaced = { owner_id, stored, previous };
  const { head_fields, item_maps } = split_cursor_fields(cursor);
  const items = count_tracked_items(item_maps);
  if (items <= sizing.single_document_items) {
    await write_single_document_cursor(ctx, layout, owner_id, cursor);
    await remove_replaced_cursor_objects(ctx, layout, {
      ...replaced,
      written_form: 'single',
      kept_names: [],
    });
    return;
  }
  const bucket_count = choose_bucket_count(items, sizing.items_per_part, previous.bucket_count);
  const parts = await write_cursor_parts(ctx, layout, item_maps, {
    owner_id,
    bucket_count,
    reusable_names: previous.names,
    write_concurrency: sizing.write_concurrency,
  });
  const fields = Object.keys(item_maps);
  await write_cursor_head(ctx, layout, owner_id, head_fields, { fields, bucket_count, parts });
  await remove_replaced_cursor_objects(ctx, layout, {
    ...replaced,
    written_form: 'parts',
    kept_names: parts,
  });
}

/** Writes the cursor as one document at `delta.json`, unlocked, and reads it back. */
async function write_single_document_cursor(
  ctx: TenantContext,
  layout: DriveCursorLayout,
  owner_id: string,
  cursor: object,
): Promise<void> {
  const key_of = (body: unknown): string =>
    layout.keys.delta_cursor_key(owner_named_by(body, layout.owner_field) ?? '');
  await write_encrypted_json(
    ctx,
    {
      key: layout.keys.delta_cursor_key(owner_id),
      label: layout.label,
      reader_check: state_names_key_check(key_of),
      write: 'overwrite',
      confirm_read_back: true,
      object_lock_policy: UNLOCKED_STATE_WRITE,
    },
    cursor,
  );
}

/** Whether ISO timestamp `a` is later than `b`; an unparseable `b` loses to a parseable `a`. */
function is_newer(a: unknown, b: unknown): boolean {
  const a_time = typeof a === 'string' ? Date.parse(a) : Number.NaN;
  const b_time = typeof b === 'string' ? Date.parse(b) : Number.NaN;
  if (Number.isNaN(a_time)) return false;
  return Number.isNaN(b_time) || a_time > b_time;
}
