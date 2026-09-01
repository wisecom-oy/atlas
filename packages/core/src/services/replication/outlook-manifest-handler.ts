import type { Manifest, ManifestRepository, TenantContext } from '@wisecom/atlas-types';

export const OUTLOOK_MANIFEST_PREFIX = 'manifests';

/** Loads an Outlook manifest by snapshot ID, throwing a located error when it is absent. */
export async function require_outlook_manifest(
  repo: ManifestRepository,
  ctx: TenantContext,
  snapshot_id: string,
  location?: 'source',
): Promise<Manifest> {
  const manifest = await repo.find_by_snapshot(ctx, snapshot_id);
  if (!manifest) {
    const where = location === 'source' ? ' on source' : '';
    throw new Error(`No manifest found for snapshot ${snapshot_id}${where}`);
  }
  return manifest;
}

/** Lists a mailbox's manifests oldest-first, so replication replays snapshots in order. */
export async function list_mailbox_manifests(
  repo: ManifestRepository,
  ctx: TenantContext,
  owner_id: string,
): Promise<Manifest[]> {
  const all = await repo.list_all_manifests(ctx);
  return all
    .filter((m) => m.owner_id === owner_id)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

/** Finds manifests present on the source but missing from the target. */
export async function diff_outlook_manifests(
  source_manifests: Manifest[],
  target_ctx: TenantContext,
  owner_id: string,
): Promise<Manifest[]> {
  const target_keys = await target_ctx.storage.list(`${OUTLOOK_MANIFEST_PREFIX}/${owner_id}/`);
  const target_snapshot_ids = new Set(
    target_keys.map((k) => k.split('/').pop()?.replace('.json', '')).filter(Boolean) as string[],
  );
  return source_manifests.filter((m) => !target_snapshot_ids.has(m.snapshot_id));
}
