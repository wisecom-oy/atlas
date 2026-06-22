import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import {
  GRAPH_CLIENT_TOKEN,
  is_invalid_delta_error,
  with_graph_retry,
} from '@wisecom/atlas-m365-graph';
import type {
  OneDriveConnector,
  OneDriveDeltaItem,
  OneDriveDeltaResult,
  OneDriveDrive,
  OneDriveFileVersion,
} from '@wisecom/atlas-types';
import { compute_chunk_timeout_ms } from '@/adapters/graph-onedrive-chunked-download';
import { stream_to_buffer } from '@/adapters/graph-onedrive-connector-stream';
import {
  graph_onedrive_create_folder,
  graph_onedrive_upload_large_file,
  graph_onedrive_upload_small_file,
} from '@/adapters/graph-onedrive-restore.adapter';
import {
  download_with_fallback,
  resolve_download_url,
  rethrow_if_access_denied,
  throw_missing_permissions,
} from '@/adapters/graph-onedrive-download-helpers';
import { map_delta_item } from '@/adapters/graph-onedrive-delta-mapper';
import { logger } from '@wisecom/atlas-core/utils/logger';

interface GraphCollectionResponse<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

interface GraphDriveRecord {
  id?: string;
  name?: string;
}

interface GraphDeltaDriveItem {
  id?: string;
  name?: string;
  size?: number;
  parentReference?: { path?: string };
  file?: Record<string, unknown>;
  folder?: Record<string, unknown>;
  '@removed'?: { reason: string };
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
        .map((drive) => ({ drive_id: drive.id ?? '', drive_name: drive.name ?? '' }));
      if (drives.length > 0) return drives;
      return await this.fallback_default_drive(owner_id);
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

  /** Downloads full file content with URL refresh and Graph content fallback. */
  async download_file_content(item: OneDriveDeltaItem): Promise<Buffer> {
    return download_with_fallback(this._client, item);
  }

  /** Resolves the temporary pre-authenticated download URL for a file. */
  async resolve_download_url(item: OneDriveDeltaItem): Promise<string | undefined> {
    return resolve_download_url(this._client, item);
  }

  /** Lists historical versions of a file, following pagination. */
  async list_file_versions(drive_id: string, item_id: string): Promise<OneDriveFileVersion[]> {
    const all_versions: OneDriveFileVersion[] = [];
    let next_url: string | undefined;

    let page = await with_graph_retry(
      () =>
        this._client
          .api(`/drives/${drive_id}/items/${item_id}/versions`)
          .select('id,lastModifiedDateTime,size')
          .get() as Promise<GraphCollectionResponse<GraphVersionRecord>>,
    );

    while (true) {
      const page_versions = (page.value ?? [])
        .filter((v) => Boolean(v.id))
        .map((v) => ({
          version_id: v.id!,
          last_modified_at: v.lastModifiedDateTime ?? '',
          size_bytes: v.size ?? 0,
        }));
      all_versions.push(...page_versions);

      next_url = page['@odata.nextLink'];
      if (!next_url) break;
      page = await with_graph_retry(
        () =>
          this._client.api(next_url!).get() as Promise<GraphCollectionResponse<GraphVersionRecord>>,
      );
    }

    if (all_versions.length <= 1) return [];
    return all_versions.slice(1);
  }

  /** Downloads a specific version's content with size-based timeout. */
  async download_file_version(
    drive_id: string,
    item_id: string,
    version_id: string,
    size_bytes?: number,
  ): Promise<Buffer> {
    const stream = await with_graph_retry(
      () =>
        this._client
          .api(`/drives/${drive_id}/items/${item_id}/versions/${version_id}/content`)
          .getStream() as Promise<NodeJS.ReadableStream>,
    );
    const timeout_ms = size_bytes ? compute_chunk_timeout_ms(size_bytes) : 120_000;
    return await stream_to_buffer(stream, timeout_ms);
  }

  async create_folder(
    _tenant_id: string,
    owner_id: string,
    drive_id: string,
    parent_id: string,
    folder_name: string,
  ): Promise<string> {
    return graph_onedrive_create_folder(this._client, owner_id, drive_id, parent_id, folder_name);
  }

  async upload_small_file(
    _tenant_id: string,
    owner_id: string,
    drive_id: string,
    parent_id: string,
    file_name: string,
    content: Buffer,
    conflict_behavior?: string,
  ): Promise<void> {
    await graph_onedrive_upload_small_file(
      this._client,
      owner_id,
      drive_id,
      parent_id,
      file_name,
      content,
      conflict_behavior,
    );
  }

  async upload_large_file(
    _tenant_id: string,
    owner_id: string,
    drive_id: string,
    parent_id: string,
    file_name: string,
    content: Buffer,
    conflict_behavior?: string,
  ): Promise<void> {
    await graph_onedrive_upload_large_file(
      this._client,
      owner_id,
      drive_id,
      parent_id,
      file_name,
      content,
      conflict_behavior,
    );
  }

  private async fallback_default_drive(owner_id: string): Promise<OneDriveDrive[]> {
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
      if (status === 404) throw_missing_permissions('read');
      throw err;
    }
    if (!default_drive.id) throw_missing_permissions('read');
    return [{ drive_id: default_drive.id, drive_name: default_drive.name ?? 'default' }];
  }

  private async fetch_initial_delta_page(
    owner_id: string,
    drive_id: string,
    prev_delta_link: string | undefined,
  ): Promise<{ page: GraphCollectionResponse<GraphDeltaDriveItem>; stale_cursor: boolean }> {
    const stale_cursor = Boolean(prev_delta_link && !prev_delta_link.includes('$select='));
    if (stale_cursor) {
      logger.warn(
        `Delta cursor for drive ${drive_id} predates field selection — performing fresh delta`,
      );
    }

    if (prev_delta_link && !stale_cursor) {
      const page = await with_graph_retry(
        () =>
          this._client.api(prev_delta_link).get() as Promise<
            GraphCollectionResponse<GraphDeltaDriveItem>
          >,
      );
      return { page, stale_cursor };
    }

    const page = await with_graph_retry(
      () =>
        this._client
          .api(`/users/${owner_id}/drives/${drive_id}/root/delta`)
          .select(DRIVE_DELTA_SELECT_FIELDS)
          .get() as Promise<GraphCollectionResponse<GraphDeltaDriveItem>>,
    );
    return { page, stale_cursor };
  }

  private async execute_delta(
    owner_id: string,
    drive_id: string,
    prev_delta_link: string | undefined,
    reset_detected: boolean,
  ): Promise<OneDriveDeltaResult> {
    const items: OneDriveDeltaItem[] = [];
    let delta_link = '';

    const { page: initial_page, stale_cursor } = await this.fetch_initial_delta_page(
      owner_id,
      drive_id,
      prev_delta_link,
    );
    let page = initial_page;

    while (true) {
      for (const raw of page.value ?? []) {
        if (!raw.id) continue;
        items.push(map_delta_item(raw, drive_id));
      }

      const next = page['@odata.nextLink'];
      if (!next) {
        if (page['@odata.deltaLink']) delta_link = page['@odata.deltaLink'];
        break;
      }
      page = await with_graph_retry(
        () => this._client.api(next).get() as Promise<GraphCollectionResponse<GraphDeltaDriveItem>>,
      );
    }

    return { drive_id, delta_link, items, reset_detected: reset_detected || Boolean(stale_cursor) };
  }
}
