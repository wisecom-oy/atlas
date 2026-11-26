import type { TenantContext } from '@wisecom/atlas-types';
import { state_names_key_check } from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import {
  write_encrypted_json,
  write_encrypted_json_text,
} from '@wisecom/atlas-core/services/shared/stored-json-writer';
import { UNLOCKED_STATE_WRITE } from '@wisecom/atlas-core/services/shared/run-object-lock';
import { BoundedTaskPool } from '@/shared/bounded-task-pool';
import {
  build_bucket_item_maps,
  index_item_ids_by_bucket,
  type CursorItemMaps,
} from '@/shared/cursor-item-buckets';
import {
  build_cursor_part_text,
  CURSOR_PARTS_VERSION,
  owner_named_by,
  require_cursor_item_parts,
  require_cursor_part,
  type CursorItemParts,
  type DriveCursorLayout,
} from '@/shared/cursor-part-document';
import { digest_part_text } from '@/shared/manifest-part-document';

/** What a multi-part cursor write needs besides the cursor's item maps. */
export interface CursorPartsWrite {
  readonly owner_id: string;
  readonly bucket_count: number;
  /** Content names of parts already stored and listed by the current head; these are not rewritten. */
  readonly reusable_names: ReadonlySet<string>;
  readonly write_concurrency: number;
}

/**
 * Writes the part of every bucket whose content has no stored part yet, and returns the content
 * name of every bucket in order. A part is named by the keyed digest of its plaintext, so a bucket
 * whose items did not change since the last run keeps its name and costs no write (#920).
 */
export async function write_cursor_parts(
  ctx: TenantContext,
  layout: DriveCursorLayout,
  item_maps: CursorItemMaps,
  write: CursorPartsWrite,
): Promise<string[]> {
  const ids = index_item_ids_by_bucket(item_maps, write.bucket_count);
  const names: string[] = [];
  const pool = new BoundedTaskPool(write.write_concurrency);
  for (let bucket = 0; bucket < write.bucket_count; bucket++) {
    const part = {
      bucket,
      bucket_count: write.bucket_count,
      maps: build_bucket_item_maps(item_maps, ids, bucket),
    };
    const text = build_cursor_part_text(layout.owner_field, write.owner_id, part);
    const part_name = digest_part_text(ctx, text);
    names.push(part_name);
    if (write.reusable_names.has(part_name)) continue;
    await pool.add(() => write_cursor_part(ctx, layout, write, { part_name, bucket, text }));
  }
  await pool.drain();
  return names;
}

/** Writes one part unlocked, as run state, and reads it back. */
async function write_cursor_part(
  ctx: TenantContext,
  layout: DriveCursorLayout,
  write: CursorPartsWrite,
  part: { readonly part_name: string; readonly bucket: number; readonly text: string },
): Promise<void> {
  const key = layout.keys.delta_cursor_part_key(write.owner_id, part.part_name);
  await write_encrypted_json_text(
    ctx,
    {
      key,
      label: `${layout.label} part`,
      reader_check: (parsed) =>
        require_cursor_part(
          parsed,
          layout,
          { key, part_name: part.part_name, bucket: part.bucket },
          write.bucket_count,
        ),
      write: 'overwrite',
      confirm_read_back: true,
      object_lock_policy: UNLOCKED_STATE_WRITE,
    },
    part.text,
  );
}

/**
 * Writes the head: every field of the cursor except its item maps, plus the list of parts. It goes
 * last and is the commit point, so a reader sees either the previous cursor or this one whole.
 */
export async function write_cursor_head(
  ctx: TenantContext,
  layout: DriveCursorLayout,
  owner_id: string,
  head_fields: Record<string, unknown>,
  item_parts: Omit<CursorItemParts, 'version'>,
): Promise<void> {
  const key_of = (head: unknown): string =>
    layout.keys.delta_cursor_head_key(owner_named_by(head, layout.owner_field) ?? '');
  await write_encrypted_json(
    ctx,
    {
      key: layout.keys.delta_cursor_head_key(owner_id),
      label: `${layout.label} head`,
      reader_check: (parsed, key) => {
        state_names_key_check(key_of)(parsed, key);
        require_cursor_item_parts((parsed as { item_parts?: unknown }).item_parts, key);
      },
      write: 'overwrite',
      confirm_read_back: true,
      object_lock_policy: UNLOCKED_STATE_WRITE,
    },
    { ...head_fields, item_parts: { version: CURSOR_PARTS_VERSION, ...item_parts } },
  );
}
