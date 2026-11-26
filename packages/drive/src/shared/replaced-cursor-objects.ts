import type { TenantContext } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type { DriveCursorLayout } from '@/shared/cursor-part-document';
import type { ReusableCursorParts, StoredCursorObjects } from '@/shared/stored-cursor-objects';

/**
 * How long a part no head lists is left alone. A save writes its parts within minutes of its head,
 * so only a part this old is demonstrably left by an interrupted save rather than one in progress.
 */
const ABANDONED_PART_AFTER_MS = 24 * 60 * 60 * 1000;

/** What a save just stored, and what was stored before it. */
export interface CursorReplacement {
  readonly owner_id: string;
  readonly stored: StoredCursorObjects;
  readonly previous: ReusableCursorParts;
  /** The form the save wrote; the other form's objects are removed. */
  readonly written_form: 'single' | 'parts';
  /** Content names of the parts the new head lists; empty for a single document. */
  readonly kept_names: readonly string[];
}

/**
 * Removes what a save replaced: the other form's document, the parts only the previous head
 * listed, and parts no head lists that are older than a day. A fresh unlisted part may belong to
 * a save still in progress elsewhere, after this run's lease lapsed, so it is left for a later run.
 *
 * Deletes a head before parts, so a failure part way leaves parts nothing references rather than a
 * head missing its parts. Logs instead of failing: the cursor itself is already stored, and the
 * next save retries.
 */
export async function remove_replaced_cursor_objects(
  ctx: TenantContext,
  layout: DriveCursorLayout,
  replacement: CursorReplacement,
): Promise<void> {
  try {
    const keys = await select_replaced_keys(ctx, layout, replacement);
    for (const key of keys) await ctx.storage.delete(key);
  } catch (err) {
    logger.warn(
      `Could not remove a replaced ${layout.label} object; the next backup retries: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The keys a save replaced, the other form's document first. */
async function select_replaced_keys(
  ctx: TenantContext,
  layout: DriveCursorLayout,
  replacement: CursorReplacement,
): Promise<string[]> {
  const { owner_id, stored, previous } = replacement;
  const key_of = (name: string): string => layout.keys.delta_cursor_part_key(owner_id, name);
  const kept = new Set(replacement.kept_names.map(key_of));
  const previously_listed = new Set([...previous.names].map(key_of));
  const superseded = [...previously_listed].filter((key) => !kept.has(key));
  const unlisted = stored.part_keys.filter((key) => !kept.has(key) && !previously_listed.has(key));
  const other_form = replacement.written_form === 'single' ? stored.head_keys : stored.single_keys;
  return [
    ...other_form,
    ...superseded,
    ...(await abandoned_among(ctx, layout, owner_id, unlisted)),
  ];
}

/** The unlisted parts old enough to have been left by an interrupted save. */
async function abandoned_among(
  ctx: TenantContext,
  layout: DriveCursorLayout,
  owner_id: string,
  unlisted: readonly string[],
): Promise<string[]> {
  if (unlisted.length === 0) return [];
  const prefix = `${layout.keys.delta_cursor_parts_prefix(owner_id)}parts/`;
  const stale = new Set(
    await ctx.storage.list_stale(prefix, new Date(Date.now() - ABANDONED_PART_AFTER_MS)),
  );
  return unlisted.filter((key) => stale.has(key));
}
