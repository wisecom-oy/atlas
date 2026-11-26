import type {
  ManifestObjectLockEffectivePolicy,
  ManifestObjectLockPolicy,
  SnapshotSummary,
} from '@wisecom/atlas-types';
import {
  parse_stored_object_lock,
  summarize_manifest_object_lock,
} from '@wisecom/atlas-core/services/shared/manifest-object-lock';
import {
  optional_string,
  stored_count,
  type SnapshotSummaryLayout,
} from '@wisecom/atlas-core/services/shared/snapshot-summary-layout';
import {
  read_drive_manifest,
  type DriveManifestLayout,
  type DriveStoredManifest,
} from '@/shared/drive-manifest-store';

/** What a drive summary row is built from, which either provider's manifest supplies. */
export interface DriveSummarizableManifest extends DriveStoredManifest {
  readonly total_files: number;
  readonly total_size_bytes: number;
  readonly entries: readonly unknown[];
  readonly object_lock?: ManifestObjectLockPolicy | undefined;
}

/**
 * The common row plus the provider's owning segment, its two display labels, file count, and the
 * Object Lock retention the manifest was written with.
 */
export type DriveSnapshotSummaryRow = SnapshotSummary & {
  readonly total_files: number;
  readonly object_lock?: ManifestObjectLockEffectivePolicy | undefined;
};

/**
 * Builds a drive provider's summary index layout (#625). The providers differ only in the field
 * naming the owning segment (`owner_id`, `site_id`) and its two display labels, so those are
 * passed as names and copied between the manifest, the row and the stored JSON as they are.
 *
 * `TSummary` must be the row these names describe; the builder cannot prove that from field
 * names, which is why the two providers each instantiate it with their own row type once.
 */
export function build_drive_summary_layout<
  TManifest extends DriveSummarizableManifest,
  TSummary extends DriveSnapshotSummaryRow,
>(
  layout: DriveManifestLayout,
  label_fields: readonly [string, string],
): SnapshotSummaryLayout<TManifest, TSummary> {
  const owner_field = layout.owner_field;
  return {
    label: layout.label,
    summary_key: (owner_id) => layout.keys.snapshot_summary_key(owner_id),
    manifest_prefix: (owner_id) => layout.keys.manifest_prefix_for(owner_id),
    manifest_root_prefix: layout.keys.manifest_root_prefix(),
    manifest_key: (owner_id, snapshot_id) => layout.keys.manifest_key(owner_id, snapshot_id),
    read_manifest: (ctx, key) => read_drive_manifest<TManifest>(ctx, layout, key),
    summarize: (manifest, manifest_key): TSummary => {
      const fields = manifest as unknown as Readonly<Record<string, unknown>>;
      const row: Record<string, unknown> = {
        snapshot_id: manifest.snapshot_id,
        created_at: manifest.created_at,
        manifest_key,
        entry_count: manifest.entries.length,
        total_size_bytes: manifest.total_size_bytes,
        total_files: manifest.total_files,
        [owner_field]: fields[owner_field],
      };
      for (const field of label_fields) row[field] = fields[field];
      const object_lock = summarize_manifest_object_lock(manifest.object_lock);
      if (object_lock) row.object_lock = object_lock;
      return row as unknown as TSummary;
    },
    parse_details: (row, common): TSummary | undefined => {
      const owner = optional_string(row, owner_field);
      const total_files = stored_count(row, 'total_files');
      const object_lock = parse_stored_object_lock(row.object_lock);
      if (typeof owner !== 'string' || total_files === undefined) return undefined;
      if (object_lock === null) return undefined;
      const parsed: Record<string, unknown> = { ...common, total_files, [owner_field]: owner };
      if (object_lock) parsed.object_lock = object_lock;
      for (const field of label_fields) {
        const label = optional_string(row, field);
        if (label === null) return undefined;
        if (label !== undefined) parsed[field] = label;
      }
      return parsed as unknown as TSummary;
    },
  };
}
