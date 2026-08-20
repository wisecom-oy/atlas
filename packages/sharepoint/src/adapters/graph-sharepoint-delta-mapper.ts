import type { SharePointDeltaItem } from '@wisecom/atlas-types';

export interface GraphDeltaDriveItem {
  id?: string;
  name?: string;
  size?: number;
  webUrl?: string;
  eTag?: string;
  lastModifiedDateTime?: string;
  parentReference?: { path?: string };
  file?: Record<string, unknown>;
  folder?: Record<string, unknown>;
  package?: { type?: string };
  /**
   * Removal marker for `driveItem` delta. Graph uses this facet, NOT the
   * `@removed` annotation that `messages/delta` uses (issue #139). It must be
   * requested explicitly: `$select` strips it otherwise.
   */
  deleted?: { state?: string };
  '@removed'?: { reason: string };
  '@microsoft.graph.downloadUrl'?: string;
}

/**
 * True when Graph returned the carcass of a removed item: an id and facets, but
 * no name.
 *
 * The `deleted` facet is the documented signal, but a saved `@odata.deltaLink`
 * pins the `$select` it was created with, so cursors written before `deleted`
 * joined the field list keep answering without it. Every live item carries a
 * name, so a nameless item is a removed one.
 */
function is_removed_shape(raw: GraphDeltaDriveItem): boolean {
  return raw.id !== undefined && raw.name === undefined;
}

/** Maps a raw Graph drive delta item to the domain SharePointDeltaItem model. */
export function map_delta_item(raw: GraphDeltaDriveItem, drive_id: string): SharePointDeltaItem {
  const parent_path = normalize_path(extract_parent_path(raw.parentReference?.path));
  const file_name = normalize_path(raw.name ?? '');
  const is_deleted = Boolean(raw.deleted ?? raw['@removed']) || is_removed_shape(raw);
  const kind: 'file' | 'folder' = raw.file
    ? 'file'
    : raw.folder
      ? 'folder'
      : is_deleted
        ? 'file'
        : 'folder';
  return {
    item_id: raw.id!,
    drive_id,
    kind,
    file_name,
    parent_path,
    size_bytes: raw.size ?? 0,
    deleted: is_deleted,
    ...(raw.package ? { package_type: raw.package.type ?? 'unknown' } : {}),
    ...(raw.webUrl ? { web_url: raw.webUrl } : {}),
    ...(raw.eTag ? { etag: raw.eTag } : {}),
    ...(raw.lastModifiedDateTime ? { last_modified_at: raw.lastModifiedDateTime } : {}),
    ...(raw['@microsoft.graph.downloadUrl']
      ? { download_url: raw['@microsoft.graph.downloadUrl'] }
      : {}),
  };
}

/** Normalizes a SharePoint path to NFC Unicode form. */
export function normalize_path(raw: string): string {
  return raw.normalize('NFC');
}

/** Extracts the parent folder path from a Graph parentReference.path value. */
export function extract_parent_path(raw_path: string | undefined): string {
  if (!raw_path) return '/';
  const marker = 'root:';
  const marker_index = raw_path.indexOf(marker);
  if (marker_index < 0) return raw_path;
  const result = raw_path.slice(marker_index + marker.length);
  return result.length === 0 ? '/' : result;
}
