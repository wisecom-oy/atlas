import type { QuarantinedObjectKind, TenantContext } from '@wisecom/atlas-types';
import type { QuarantineTarget } from '@wisecom/atlas-core/services/quarantine/stored-object-quarantine';
import type { DriveStorageKeys } from '@/shared/storage-keys';

/** The two reads a drive provider exposes for one stored object, as its repositories do. */
export interface DriveQuarantineReads {
  readonly read_manifest: (ctx: TenantContext, storage_key: string) => Promise<unknown>;
  readonly read_index_object: (ctx: TenantContext, storage_key: string) => Promise<unknown>;
}

/**
 * Builds the quarantine target of one drive provider. A manifest is `{manifests}/{owner}/{id}.json`;
 * a version index is any `.json` object under `{index}/{owner}/`, which covers the per-run objects
 * and the legacy per-file ones alike.
 */
export function drive_quarantine_target(
  workload: string,
  keys: DriveStorageKeys,
  reads: DriveQuarantineReads,
): QuarantineTarget {
  const kind_of = (storage_key: string): QuarantinedObjectKind | undefined => {
    if (is_owner_json(storage_key, keys.manifest_prefix, false)) return 'manifest';
    if (is_owner_json(storage_key, keys.index_prefix, true)) return 'version_index';
    return undefined;
  };
  return {
    workload,
    accepts: `${workload} manifests and version indexes`,
    kind_of,
    read: (ctx, storage_key) =>
      kind_of(storage_key) === 'manifest'
        ? reads.read_manifest(ctx, storage_key)
        : reads.read_index_object(ctx, storage_key),
  };
}

/** Whether a key is a `.json` object under `{prefix}/{owner}/`, optionally in a subdirectory. */
function is_owner_json(storage_key: string, prefix: string, nested: boolean): boolean {
  if (!storage_key.startsWith(`${prefix}/`) || !storage_key.endsWith('.json')) return false;
  const segments = storage_key.slice(prefix.length + 1).split('/');
  const shape_ok = nested ? segments.length >= 2 : segments.length === 2;
  return shape_ok && segments.every((segment) => segment !== '' && segment !== '..');
}
