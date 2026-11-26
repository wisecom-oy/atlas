import type { TenantContext } from '@wisecom/atlas-types';
import { QUARANTINE_PREFIX } from '@wisecom/atlas-core/services/quarantine/stored-object-quarantine';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type { DriveManifestLayout } from '@/shared/drive-manifest-document';

/**
 * Removes the entry parts of multi-part manifests whose head was never written, which is what an
 * interrupted save leaves behind (#920). Logs instead of failing: an orphan costs storage only,
 * because no reader looks at a part that no head lists.
 *
 * A part set is kept while its head exists, in place or moved aside by `quarantine`, so a
 * quarantined manifest stays readable. The caller holds the owner's lease, so no other save of
 * this owner can be between writing its parts and its head.
 *
 * Under Object Lock the delete only adds a delete marker; the locked bytes stay until their
 * retention ends and the noncurrent-version rule removes them.
 */
export async function sweep_orphan_manifest_parts(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  owner_id: string,
): Promise<void> {
  try {
    const orphan_keys = await find_orphan_part_keys(ctx, layout, owner_id);
    for (const key of orphan_keys) await ctx.storage.delete(key);
    if (orphan_keys.length > 0) {
      logger.info(`Removed ${orphan_keys.length} ${layout.label} manifest part(s) with no head`);
    }
  } catch (err) {
    logger.warn(
      `Could not remove ${layout.label} manifest parts left by an interrupted backup: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The part keys whose snapshot has no head, in place or quarantined. */
async function find_orphan_part_keys(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  owner_id: string,
): Promise<string[]> {
  const part_keys = await ctx.storage.list(layout.keys.manifest_parts_prefix_for(owner_id));
  if (part_keys.length === 0) return [];
  const manifest_prefix = layout.keys.manifest_prefix_for(owner_id);
  const heads = new Set([
    ...(await ctx.storage.list(manifest_prefix)),
    ...(await ctx.storage.list(`${QUARANTINE_PREFIX}${manifest_prefix}`)).map(original_key_of),
  ]);
  const parts_prefix = layout.keys.manifest_parts_prefix_for(owner_id);
  return part_keys.filter((key) => {
    const snapshot_id = key.slice(parts_prefix.length).split('/')[0] ?? '';
    return !heads.has(head_key_or_undefined(layout, owner_id, snapshot_id) ?? '');
  });
}

/**
 * The key a quarantined copy was moved from. A second copy of the same key carries a timestamp
 * suffix after `.json`, which is dropped here.
 */
function original_key_of(quarantine_key: string): string {
  return quarantine_key.slice(QUARANTINE_PREFIX.length).replace(/\.json\.\d+$/, '.json');
}

/** The head key of a snapshot named by a part path, or undefined when the name is not valid. */
function head_key_or_undefined(
  layout: DriveManifestLayout,
  owner_id: string,
  snapshot_id: string,
): string | undefined {
  try {
    return layout.keys.manifest_key(owner_id, snapshot_id);
  } catch {
    return undefined;
  }
}
