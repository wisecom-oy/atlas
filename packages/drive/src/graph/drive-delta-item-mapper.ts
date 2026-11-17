import { map_graph_file_system_info, map_graph_identity } from '@wisecom/atlas-m365-graph';
import type { DriveEntryKind } from '@wisecom/atlas-types';
import type { DriveDeltaItem } from '@/drive-ports';
import type { GraphDeltaDriveItem, IdentifiedGraphDeltaDriveItem } from '@/graph/graph-drive-item';

/** Normalizes a drive path to NFC Unicode form. */
export function normalize_path(raw: string): string {
  return raw.normalize('NFC');
}

/** Extracts the parent folder path from a Graph `parentReference.path` value. */
export function extract_parent_path(raw_path: string | undefined): string {
  if (!raw_path) return '/';
  const marker = 'root:';
  const marker_index = raw_path.indexOf(marker);
  if (marker_index < 0) return raw_path;
  const result = raw_path.slice(marker_index + marker.length);
  return result.length === 0 ? '/' : result;
}

/**
 * True when Graph returned the carcass of a removed item: an id and facets, but no name.
 *
 * The `deleted` facet is the documented signal, but a saved `@odata.deltaLink` pins the `$select`
 * it was created with, so cursors written before `deleted` joined the field list keep answering
 * without it. Every live item carries a name (the drive root included), so a nameless item is a
 * removed one, and this keeps deletions visible on existing cursors instead of waiting for a full
 * re-enumeration.
 */
function is_removed_shape(raw: GraphDeltaDriveItem): boolean {
  return raw.id !== undefined && raw.name === undefined;
}

/** Whether Graph returned the item with a usable id. An item without one cannot be recorded. */
export function has_item_id(raw: GraphDeltaDriveItem): raw is IdentifiedGraphDeltaDriveItem {
  return typeof raw.id === 'string' && raw.id.length > 0;
}

/**
 * The kind an item is recorded as. Graph sends a removed item without its facets, so a deletion
 * reads as a file and the backup resolves its real kind from what the cursor recorded. Any other
 * live item without `file` is a folder.
 */
export function classify_drive_item_kind(
  raw: GraphDeltaDriveItem,
  is_deleted: boolean,
): DriveEntryKind {
  if (raw.file) return 'file';
  if (raw.folder) return 'folder';
  return is_deleted ? 'file' : 'folder';
}

/** Maps a raw Graph delta drive item to the domain delta item both providers share. */
export function map_drive_delta_item(
  raw: IdentifiedGraphDeltaDriveItem,
  drive_id: string,
): DriveDeltaItem {
  const parent_path = normalize_path(extract_parent_path(raw.parentReference?.path));
  const file_name = normalize_path(raw.name ?? '');
  const is_deleted = Boolean(raw.deleted ?? raw['@removed']) || is_removed_shape(raw);
  const kind = classify_drive_item_kind(raw, is_deleted);
  return {
    item_id: raw.id,
    drive_id,
    kind,
    file_name,
    parent_path,
    size_bytes: raw.size ?? 0,
    deleted: is_deleted,
    ...(raw.malware ? { quarantined: true } : {}),
    ...(raw.package ? { package_type: raw.package.type ?? 'unknown' } : {}),
    ...(raw.webUrl ? { web_url: raw.webUrl } : {}),
    ...(raw.eTag ? { etag: raw.eTag } : {}),
    ...(raw.lastModifiedDateTime ? { last_modified_at: raw.lastModifiedDateTime } : {}),
    ...spread_optional('file_system_info', map_graph_file_system_info(raw.fileSystemInfo)),
    ...spread_optional('created_by', map_graph_identity(raw.createdBy)),
    ...spread_optional('last_modified_by', map_graph_identity(raw.lastModifiedBy)),
    ...(raw['@microsoft.graph.downloadUrl']
      ? { download_url: raw['@microsoft.graph.downloadUrl'] }
      : {}),
    ...(raw.root ? { is_root: true } : {}),
    ...(raw.shared ? { sharing_facet: true } : {}),
  };
}

/** Includes a key only when its value exists, for `exactOptionalPropertyTypes`. */
function spread_optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : { [key]: value };
}
