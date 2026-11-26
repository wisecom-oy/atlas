import type { Manifest, ManifestRepository, TenantContext } from '@wisecom/atlas-types';
import { quarantined_copies_of } from '@/services/quarantine/stored-object-quarantine';
import {
  OutlookBaselineFold,
  outlook_baseline_matches,
} from '@/services/retention/outlook-baseline-fold';
import type { ReferencedKeySet } from '@/services/retention/referenced-key-set';
import type { SnapshotPruneTarget } from '@/services/retention/snapshot-prune-target';

/**
 * One mailbox as the prune sees it. Outlook keeps its manifests and content at the bucket root,
 * and a pointer per snapshot under `_meta/outlook-manifests/snapshots/`. The latest pointer and the
 * delta cursor name the newest snapshot, which a prune never removes, so they are left alone.
 */
export function outlook_prune_target(
  ctx: TenantContext,
  manifests: ManifestRepository,
  owner_id: string,
): SnapshotPruneTarget<Manifest> {
  const manifest_prefix = `manifests/${owner_id}/`;
  return {
    label: 'Outlook',
    ctx,
    manifest_prefix,
    content_prefixes: [`data/${owner_id}/`, `attachments/${owner_id}/`],
    quarantine_prefixes: quarantined_copies_of([manifest_prefix]),
    stale_satellites: [],
    list_summaries: () => manifests.list_snapshot_summaries(ctx, owner_id),
    read_manifest: (key) => manifests.read_manifest_at(ctx, key),
    start_fold: () => new OutlookBaselineFold(),
    baseline_matches: outlook_baseline_matches,
    commit_baseline: (baseline, lease) => manifests.replace_with_baseline(ctx, baseline, lease),
    satellite_scopes: (snapshot_id) => [
      `_meta/outlook-manifests/snapshots/${snapshot_id}.json`,
      // Replication status records Atlas 6 wrote, one folder per snapshot (see `DeletionService`).
      `_meta/replication/${owner_id}/${snapshot_id}/`,
    ],
    forget_rows: (snapshot_ids, lease) =>
      manifests.forget_snapshot_summaries(ctx, owner_id, snapshot_ids, lease),
    add_references: add_outlook_references,
  };
}

/** Records the message blobs and legacy attachment blobs a manifest names. */
function add_outlook_references(manifest: Manifest, references: ReferencedKeySet): void {
  for (const entry of manifest.entries) {
    references.add(entry.storage_key);
    for (const attachment of entry.attachments ?? []) references.add(attachment.storage_key);
  }
}
