import type { StorageObjectLockPolicy, TenantContext } from '@wisecom/atlas-types';
import { delete_scopes } from '@wisecom/atlas-core/services/deletion/shared/prefix-deleter';
import {
  is_json_record,
  read_encrypted_json,
} from '@wisecom/atlas-core/services/shared/stored-json-reader';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type { DriveManifestLayout, DriveStoredManifest } from '@/shared/drive-manifest-document';
import {
  DEFAULT_MANIFEST_SIZING,
  write_drive_manifest_document,
  type DriveWritableManifest,
  type ManifestSizing,
} from '@/shared/manifest-part-writer';

/**
 * Writes a folded baseline over a kept snapshot's manifest, so that every step leaves a manifest a
 * reader accepts (#977).
 *
 * The parts of a manifest live at keys fixed by snapshot and position, and the head names each
 * part's digest. Overwriting the parts of a manifest whose head lists parts would leave that head
 * naming parts that no longer match it until the new head lands. So:
 *
 * - When the stored manifest is one document, the baseline is written as a backup writes it: as
 *   parts when large, overwriting any left by an interrupted attempt (no head lists them), and then
 *   the head, which replaces the old document in one write.
 * - When the stored manifest lists parts, the baseline is written as one document, which replaces
 *   the old head in one write whatever its size. The next prune, which moves the baseline to a newer
 *   snapshot, writes it in parts again.
 *
 * Parts the new head no longer lists are removed afterwards; one that survives is only unreferenced.
 */
export async function replace_drive_manifest(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  owner_id: string,
  manifest: DriveStoredManifest,
  object_lock_policy: StorageObjectLockPolicy | undefined,
  sizing: ManifestSizing = DEFAULT_MANIFEST_SIZING,
): Promise<void> {
  const key = layout.keys.manifest_key(owner_id, manifest.snapshot_id);
  const single_document = await is_stored_in_parts(ctx, layout, key);
  const part_count = await write_drive_manifest_document(
    ctx,
    layout,
    owner_id,
    manifest as DriveWritableManifest,
    sizing,
    { write: 'overwrite', single_document, object_lock_policy },
  );
  await remove_unlisted_parts(ctx, layout, owner_id, manifest.snapshot_id, part_count);
}

/** Whether the document at the manifest key is a head that lists entry parts. */
async function is_stored_in_parts(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  key: string,
): Promise<boolean> {
  const parsed = await read_encrypted_json(ctx, key, `${layout.label} manifest`);
  return is_json_record(parsed) && 'entry_parts' in parsed;
}

/** Removes every version of the snapshot's parts at or past `part_count`; logs on failure. */
async function remove_unlisted_parts(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  owner_id: string,
  snapshot_id: string,
  part_count: number,
): Promise<void> {
  try {
    const prefix = layout.keys.manifest_snapshot_parts_prefix(owner_id, snapshot_id);
    const unlisted = (await ctx.storage.list(prefix)).filter(
      (key) => part_index_of(key, prefix) >= part_count,
    );
    await delete_scopes(ctx.storage, unlisted);
  } catch (err) {
    logger.warn(
      `Could not remove ${layout.label} manifest parts the baseline of ${snapshot_id} no longer ` +
        `lists: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The position a part key names; a key that names none counts as unlisted. */
function part_index_of(key: string, prefix: string): number {
  const index = Number(key.slice(prefix.length).replace(/\.json$/, ''));
  return Number.isSafeInteger(index) ? index : Number.POSITIVE_INFINITY;
}
