import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import { GRAPH_CLIENT_TOKEN, is_invalid_delta_error, with_graph_retry } from '@atlas/m365-graph';
import type {
  OneDriveConnector,
  OneDriveDeltaItem,
  OneDriveDeltaResult,
  OneDriveDrive,
  OneDriveFileVersion,
} from '@atlas/types';
import {
  CHUNK_DOWNLOAD_THRESHOLD,
  compute_chunk_timeout_ms,
  download_file_chunked,
} from '@/adapters/graph-onedrive-chunked-download';
import {
  download_from_url,
  stream_to_buffer,
  with_timeout,
} from '@/adapters/graph-onedrive-connector-stream';
import {
  graph_onedrive_create_folder,
  graph_onedrive_upload_large_file,
  graph_onedrive_upload_small_file,
} from '@/adapters/graph-onedrive-restore.adapter';

interface GraphCollectionResponse<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

interface GraphDriveRecord {
  id?: string;
  name?: string;
}

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

interface GraphDriveItemDownload {
  '@microsoft.graph.downloadUrl'?: string;
}

interface GraphVersionRecord {
  id?: string;
  lastModifiedDateTime?: string;
  size?: number;
}

const DRIVE_DELTA_SELECT_FIELDS = [
  'id',
  'name',
  'size',
  'webUrl',
  'eTag',
  'lastModifiedDateTime',
  'parentReference',
  'file',
  'folder',
  '@microsoft.graph.downloadUrl',
].join(',');

/** Normalizes a path string to NFC form for consistent cross-platform comparison. */
function normalize_path(raw: string): string {
  return raw.normalize('NFC');
}

/** Microsoft Graph adapter for OneDrive delta sync and file download. */
@injectable()
export class GraphOneDriveConnector implements OneDriveConnector {
  constructor(@inject(GRAPH_CLIENT_TOKEN) private readonly _client: Client) {}

  /** Lists all OneDrive drives for a user (falls back to default drive). */
  async list_drives(_tenant_id: string, owner_id: string): Promise<OneDriveDrive[]> {
    try {
      const response = await with_graph_retry(
        () =>
          this._client.api(`/users/${owner_id}/drives?$select=id,name`).get() as Promise<
            GraphCollectionResponse<GraphDriveRecord>
          >,
      );
      const drives = (response.value ?? [])
        .filter((drive) => Boolean(drive.id))
        .map((drive) => ({
          drive_id: drive.id ?? '',
          drive_name: drive.name ?? '',
        }));
      if (drives.length > 0) return drives;

      let default_drive: GraphDriveRecord | undefined;
      try {
        default_drive = await with_graph_retry(
          () =>
            this._client
              .api(`/users/${owner_id}/drive?$select=id,name`)
              .get() as Promise<GraphDriveRecord>,
        );
      } catch (err) {
        const status = (err as Record<string, unknown>).statusCode;
        if (status === 404) throw_missing_permissions();
        throw err;
      }
      if (!default_drive.id) throw_missing_permissions();
      return [{ drive_id: default_drive.id, drive_name: default_drive.name ?? 'default' }];
    } catch (err) {
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  /** Fetches delta changes since the last sync, with automatic reset handling. */
  async fetch_delta(
    _tenant_id: string,
    owner_id: string,
    drive_id: string,
    prev_delta_link?: string,
  ): Promise<OneDriveDeltaResult> {
    try {
      return await this.execute_delta(owner_id, drive_id, prev_delta_link, false);
    } catch (err) {
      rethrow_if_access_denied(err);
      if (is_invalid_delta_error(err)) {
        return await this.execute_delta(owner_id, drive_id, undefined, true);
      }
      throw err;
    }
  }

  /** Downloads full file content (uses chunked download for files > 4MB). */
  async download_file_content(item: OneDriveDeltaItem): Promise<Buffer> {
    const download_url = item.download_url ?? (await this.resolve_download_url(item));

    if (download_url && item.size_bytes > CHUNK_DOWNLOAD_THRESHOLD) {
      try {
        return await download_file_chunked(download_url, item.size_bytes, item.item_id);
      } catch {
        return await this.download_via_graph_content(item);
      }
    }

    if (download_url) {
      try {
        return await download_from_url(download_url, item.size_bytes, item.item_id);
      } catch {
        return await this.download_via_graph_content(item);
      }
    }

    return await this.download_via_graph_content(item);
  }

  /** Resolves the temporary pre-authenticated download URL for a file. */
  async resolve_download_url(item: OneDriveDeltaItem): Promise<string | undefined> {
    const response = await with_graph_retry(
      () =>
        this._client
          .api(`/drives/${item.drive_id}/items/${item.item_id}`)
          .select('@microsoft.graph.downloadUrl')
          .get() as Promise<GraphDriveItemDownload>,
    );
    return response['@microsoft.graph.downloadUrl'];
  }

  /** Lists historical versions of a file (excludes the current version, which is already backed up via the main pipeline). */
  async list_file_versions(drive_id: string, item_id: string): Promise<OneDriveFileVersion[]> {
    const response = await with_graph_retry(
      () =>
        this._client
          .api(`/drives/${drive_id}/items/${item_id}/versions`)
          .select('id,lastModifiedDateTime,size')
          .get() as Promise<GraphCollectionResponse<GraphVersionRecord>>,
    );
    const all_versions = (response.value ?? [])
      .filter((v) => Boolean(v.id))
      .map((v) => ({
        version_id: v.id!,
        last_modified_at: v.lastModifiedDateTime ?? '',
        size_bytes: v.size ?? 0,
      }));

    // Graph returns versions newest-first; the first entry is the current version
    // which cannot be downloaded via /versions/{id}/content (must use /items/{id}/content).
    // Our main backup pipeline already stores the current version, so skip it here.
    return all_versions.slice(1);
  }

  /** Downloads a specific version's content. */
  async download_file_version(
    drive_id: string,
    item_id: string,
    version_id: string,
  ): Promise<Buffer> {
    const stream = await with_graph_retry(
      () =>
        this._client
          .api(`/drives/${drive_id}/items/${item_id}/versions/${version_id}/content`)
          .getStream() as Promise<NodeJS.ReadableStream>,
    );
    return await stream_to_buffer(stream, 120_000);
  }

  /** Creates a folder in the user's drive. Returns the folder's item ID. */
  async create_folder(
    _tenant_id: string,
    owner_id: string,
    drive_id: string,
    parent_id: string,
    folder_name: string,
  ): Promise<string> {
    return graph_onedrive_create_folder(this._client, owner_id, drive_id, parent_id, folder_name);
  }

  /** Uploads a small file (4 MiB or smaller) to OneDrive. */
  async upload_small_file(
    _tenant_id: string,
    owner_id: string,
    drive_id: string,
    parent_id: string,
    file_name: string,
    content: Buffer,
  ): Promise<void> {
    await graph_onedrive_upload_small_file(
      this._client,
      owner_id,
      drive_id,
      parent_id,
      file_name,
      content,
    );
  }

  /** Uploads a large file via resumable upload session. */
  async upload_large_file(
    _tenant_id: string,
    owner_id: string,
    drive_id: string,
    parent_id: string,
    file_name: string,
    content: Buffer,
  ): Promise<void> {
    await graph_onedrive_upload_large_file(
      this._client,
      owner_id,
      drive_id,
      parent_id,
      file_name,
      content,
    );
  }

  private async download_via_graph_content(item: OneDriveDeltaItem): Promise<Buffer> {
    const stream_timeout_ms = compute_chunk_timeout_ms(item.size_bytes);
    const stream = await with_timeout(
      with_graph_retry(
        () =>
          this._client
            .api(`/drives/${item.drive_id}/items/${item.item_id}/content`)
            .getStream() as Promise<NodeJS.ReadableStream>,
      ),
      stream_timeout_ms,
      `Graph content request timed out for file ${item.item_id}`,
    );
    const drain_timeout_ms = compute_chunk_timeout_ms(item.size_bytes) * 2;
    return await stream_to_buffer(stream, drain_timeout_ms);
  }

  private async execute_delta(
    owner_id: string,
    drive_id: string,
    prev_delta_link: string | undefined,
    reset_detected: boolean,
  ): Promise<OneDriveDeltaResult> {
    const items: OneDriveDeltaItem[] = [];
    let page: GraphCollectionResponse<GraphDeltaDriveItem>;
    let delta_link = '';

    if (prev_delta_link) {
      page = await with_graph_retry(
        () =>
          this._client.api(prev_delta_link).get() as Promise<
            GraphCollectionResponse<GraphDeltaDriveItem>
          >,
      );
    } else {
      page = await with_graph_retry(
        () =>
          this._client
            .api(`/users/${owner_id}/drives/${drive_id}/root/delta`)
            .select(DRIVE_DELTA_SELECT_FIELDS)
            .get() as Promise<GraphCollectionResponse<GraphDeltaDriveItem>>,
      );
    }

    while (true) {
      for (const raw of page.value ?? []) {
        if (!raw.id) continue;
        const parent_path = normalize_path(this.extract_parent_path(raw.parentReference?.path));
        const file_name = normalize_path(raw.name ?? '');
        const kind: 'file' | 'folder' = raw.file ? 'file' : 'folder';
        const item: OneDriveDeltaItem = {
          item_id: raw.id,
          drive_id,
          kind,
          file_name,
          parent_path,
          size_bytes: raw.size ?? 0,
          deleted: Boolean(raw['@removed']),
          ...(raw.webUrl ? { web_url: raw.webUrl } : {}),
          ...(raw.eTag ? { etag: raw.eTag } : {}),
          ...(raw.lastModifiedDateTime ? { last_modified_at: raw.lastModifiedDateTime } : {}),
          ...(raw['@microsoft.graph.downloadUrl']
            ? { download_url: raw['@microsoft.graph.downloadUrl'] }
            : {}),
        };
        items.push(item);
      }

      if (page['@odata.deltaLink']) {
        delta_link = page['@odata.deltaLink'];
      }

      const next = page['@odata.nextLink'];
      if (!next) break;
      page = await with_graph_retry(
        () => this._client.api(next).get() as Promise<GraphCollectionResponse<GraphDeltaDriveItem>>,
      );
    }

    return { drive_id, delta_link, items, reset_detected };
  }

  private extract_parent_path(raw_path: string | undefined): string {
    if (!raw_path) return '/';
    const marker = 'root:';
    const marker_index = raw_path.indexOf(marker);
    if (marker_index < 0) return raw_path;
    const result = raw_path.slice(marker_index + marker.length);
    return result.length === 0 ? '/' : result;
  }
}

function rethrow_if_access_denied(err: unknown): void {
  const graph_err = err as Record<string, unknown>;
  if (graph_err.statusCode !== 403) return;
  throw_missing_permissions();
}

function throw_missing_permissions(): never {
  throw new Error(
    'Missing Microsoft Graph application permissions for OneDrive: Files.Read.All, Sites.Read.All.',
  );
}
