import type { OneDriveDeltaItem } from '@wisecom/atlas-types';

interface GraphParentReference {
  path?: string;
}

interface GraphDeltaDriveItem {
  id?: string;
  name?: string;
  size?: number;
  webUrl?: string;
  eTag?: string;
  lastModifiedDateTime?: string;
  parentReference?: GraphParentReference;
  file?: Record<string, unknown>;
  folder?: Record<string, unknown>;
  '@removed'?: { reason: string };
  '@microsoft.graph.downloadUrl'?: string;
}

function normalize_path(raw: string): string {
  return raw.normalize('NFC');
}

function extract_parent_path(raw_path: string | undefined): string {
  if (!raw_path) return '/';
  const marker = 'root:';
  const marker_index = raw_path.indexOf(marker);
  if (marker_index < 0) return raw_path;
  const result = raw_path.slice(marker_index + marker.length);
  return result.length === 0 ? '/' : result;
}

/** Maps a raw Graph delta drive item to the domain delta item. */
export function map_delta_item(raw: GraphDeltaDriveItem, drive_id: string): OneDriveDeltaItem {
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
