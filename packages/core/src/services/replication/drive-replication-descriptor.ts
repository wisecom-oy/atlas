import type { OneDriveSnapshotManifest, SharePointSnapshotManifest } from '@wisecom/atlas-types';

/**
 * The whole difference between replicating a OneDrive snapshot and a SharePoint one: where the
 * objects live and what the owning segment is called. Everything else about the copy is identical,
 * so the shared replication path takes this descriptor instead of carrying a provider branch.
 */
export interface DriveReplicationDescriptor<TManifest> {
  /** Root under which a snapshot manifest is stored, without a trailing slash. */
  readonly manifest_prefix: string;
  /** Root under which per-owner version index objects are stored. */
  readonly index_prefix: string;
  /** Root under which per-owner metadata such as the delta cursor is stored. */
  readonly meta_prefix: string;
  /** Owning segment of a manifest: the drive owner for OneDrive, the site for SharePoint. */
  readonly owner_id_of: (manifest: TManifest) => string;
}

// The descriptors live in core beside the code that consumes them. Handing registration to the
// workload packages only starts to pay when a fourth drive-shaped workload arrives; until then it
// buys an indirection and no fewer edits.

export const ONEDRIVE_REPLICATION: DriveReplicationDescriptor<OneDriveSnapshotManifest> = {
  manifest_prefix: 'onedrive/manifests',
  index_prefix: 'onedrive/index',
  meta_prefix: 'onedrive/_meta',
  owner_id_of: (manifest) => manifest.owner_id,
};

export const SHAREPOINT_REPLICATION: DriveReplicationDescriptor<SharePointSnapshotManifest> = {
  manifest_prefix: 'sharepoint/manifests',
  index_prefix: 'sharepoint/index',
  meta_prefix: 'sharepoint/_meta',
  owner_id_of: (manifest) => manifest.site_id,
};

/** Storage key of a snapshot's manifest under its workload prefix. */
export function drive_manifest_key<TManifest extends { snapshot_id: string }>(
  descriptor: DriveReplicationDescriptor<TManifest>,
  manifest: TManifest,
): string {
  return `${descriptor.manifest_prefix}/${descriptor.owner_id_of(manifest)}/${manifest.snapshot_id}.json`;
}
