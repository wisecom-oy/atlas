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
  '@removed'?: { reason: string };
  '@microsoft.graph.downloadUrl'?: string;
}

/** Maps a raw Graph drive delta item to the domain SharePointDeltaItem model. */
export function map_delta_item(raw: GraphDeltaDriveItem, drive_id: string): SharePointDeltaItem {
  const parent_path = normalize_path(extract_parent_path(raw.parentReference?.path));
  const file_name = normalize_path(raw.name ?? '');
  const is_deleted = Boolean(raw['@removed']);
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
