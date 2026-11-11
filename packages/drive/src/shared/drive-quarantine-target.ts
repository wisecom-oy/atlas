import type { QuarantinedObjectKind, TenantContext } from '@wisecom/atlas-types';
import type { QuarantineTarget } from '@wisecom/atlas-core/services/quarantine/stored-object-quarantine';
import type { DriveStorageKeys } from '@/shared/storage-keys';

/** The two reads a drive provider exposes for one stored object, as its repositories do. */
export interface DriveQuarantineReads {
  readonly read_manifest: (ctx: TenantContext, storage_key: string) => Promise<unknown>;
  readonly read_index_object: (ctx: TenantContext, storage_key: string) => Promise<unknown>;
}

/**
 * Builds the quarantine target of one drive provider. A key is accepted only when it is exactly
 * the key Atlas builds from its own segments: a manifest `{manifests}/{owner}/{snapshot}.json`, a
 * per-run version index `{index}/{owner}/runs/{snapshot}.json`, or a legacy per-file index
 * `{index}/{owner}/files/{file}.json`. Anything else, including `.` or `..` segments or another
 * spelling of the owner, is refused before it is read.
 */
export function drive_quarantine_target(
  workload: string,
  keys: DriveStorageKeys,
  reads: DriveQuarantineReads,
): QuarantineTarget {
  const kind_of = (storage_key: string): QuarantinedObjectKind | undefined =>
    kind_of_drive_key(keys, storage_key);
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

/** The kind of object a drive key names when Atlas would write exactly that key, else undefined. */
function kind_of_drive_key(
  keys: DriveStorageKeys,
  storage_key: string,
): QuarantinedObjectKind | undefined {
  const manifest = segments_under(storage_key, keys.manifest_prefix, 2);
  if (manifest) {
    const [owner = '', name = ''] = manifest;
    const ok = rebuilds(storage_key, () => keys.manifest_key(owner, strip_json(name)));
    return ok ? 'manifest' : undefined;
  }
  const index = segments_under(storage_key, keys.index_prefix, 3);
  if (!index) return undefined;
  const [owner = '', folder = '', name = ''] = index;
  if (folder === 'runs') {
    const ok = rebuilds(storage_key, () => keys.run_index_key(owner, strip_json(name)));
    return ok ? 'version_index' : undefined;
  }
  const legacy_ok =
    folder === 'files' &&
    rebuilds(`${keys.index_prefix}/${owner}/`, () => keys.index_prefix_for(owner)) &&
    rebuilds(name, () => {
      keys.validate_key_segment(strip_json(name));
      return name;
    });
  return legacy_ok ? 'version_index' : undefined;
}

/** The segments after `{prefix}/` when there are exactly `count` and the key ends in `.json`. */
function segments_under(storage_key: string, prefix: string, count: number): string[] | undefined {
  if (!storage_key.startsWith(`${prefix}/`) || !storage_key.endsWith('.json')) return undefined;
  const segments = storage_key.slice(prefix.length + 1).split('/');
  return segments.length === count ? segments : undefined;
}

function strip_json(name: string): string {
  return name.slice(0, -'.json'.length);
}

/** Whether the key builder reproduces `expected` exactly; a builder that refuses never does. */
function rebuilds(expected: string, build: () => string): boolean {
  try {
    return build() === expected;
  } catch {
    return false;
  }
}
