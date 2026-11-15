import { Readable } from 'node:stream';
import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import {
  list_drive_item_versions,
  GRAPH_CLIENT_TOKEN,
  get_graph_content_stream,
  is_invalid_delta_error,
  no_onedrive_message,
  rethrow_if_no_onedrive,
  with_graph_retry,
} from '@wisecom/atlas-m365-graph';
import type {
  DriveAccessGrantRequest,
  DriveFileSystemInfo,
  DriveLinkRequest,
  DrivePermission,
  DriveSharingConnector,
  DriveSharingWriteOutcome,
  LargeFileContent,
  OneDriveConnector,
  OneDriveDeltaItem,
  OneDriveDeltaResult,
  OneDriveDrive,
  OneDriveFileVersion,
} from '@wisecom/atlas-types';
import { NotFoundError } from '@wisecom/atlas-types';
import { compute_chunk_timeout_ms } from '@wisecom/atlas-drive/backup/cdn-chunk-request';
import { stream_to_buffer } from '@wisecom/atlas-drive/backup/stream-drain';
import {
  graph_onedrive_create_folder,
  graph_onedrive_upload_large_file,
  graph_onedrive_upload_small_file,
} from '@/adapters/graph-onedrive-restore.adapter';
import { ONEDRIVE_DOWNLOAD_EXECUTOR } from '@/adapters/graph-onedrive-download-executor';
import { execute_onedrive_delta } from '@/adapters/graph-onedrive-delta-fetch';
import { create_graph_drive_sharing } from '@wisecom/atlas-drive/permissions/graph-drive-sharing';
import { graph_onedrive_fetch_item_by_id } from '@/adapters/graph-onedrive-item-fetch';

/** Floor for draining one buffered version, whatever its listed size. */
const VERSION_DRAIN_TIMEOUT_MS = 120_000;

interface GraphCollectionResponse<T> {
  value?: T[];
}

interface GraphDriveRecord {
  id?: string;
  name?: string;
}

/** Microsoft Graph adapter for OneDrive delta sync, file download, restore and sharing. */
@injectable()
export class GraphOneDriveConnector implements OneDriveConnector {
  private readonly _sharing: DriveSharingConnector;

  constructor(@inject(GRAPH_CLIENT_TOKEN) private readonly _client: Client) {
    this._sharing = create_graph_drive_sharing(_client);
  }

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
      await ONEDRIVE_DOWNLOAD_EXECUTOR.rethrow_if_access_denied(this._client, err, {
        label: `owner ${owner_id}`,
        owner_id,
      });
      rethrow_if_no_onedrive(err, owner_id);
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
    const drive = { label: `drive ${drive_id} of owner ${owner_id}`, owner_id, drive_id };
    try {
      return await execute_onedrive_delta(this._client, owner_id, drive_id, prev_delta_link, false);
    } catch (err) {
      await ONEDRIVE_DOWNLOAD_EXECUTOR.rethrow_if_access_denied(this._client, err, drive);
      if (!is_invalid_delta_error(err)) throw err;
    }
    // The full read after an expired cursor classifies a 403 the same way.
    try {
      return await execute_onedrive_delta(this._client, owner_id, drive_id, undefined, true);
    } catch (err) {
      await ONEDRIVE_DOWNLOAD_EXECUTOR.rethrow_if_access_denied(this._client, err, drive);
      throw err;
    }
  }

  /** Reads one item by id to retry a past failure; undefined once Graph reports it gone. */
  async fetch_item_by_id(
    _tenant_id: string,
    _owner_id: string,
    drive_id: string,
    item_id: string,
  ): Promise<OneDriveDeltaItem | undefined> {
    return graph_onedrive_fetch_item_by_id(this._client, drive_id, item_id);
  }

  /** Downloads full file content with URL refresh and Graph content fallback. */
  async download_file_content(
    item: OneDriveDeltaItem,
    abort_signal?: AbortSignal,
  ): Promise<Buffer> {
    return ONEDRIVE_DOWNLOAD_EXECUTOR.download_with_fallback(this._client, item, abort_signal);
  }

  /** Resolves the temporary pre-authenticated download URL for a file. */
  async resolve_download_url(item: OneDriveDeltaItem): Promise<string | undefined> {
    return ONEDRIVE_DOWNLOAD_EXECUTOR.resolve_download_url(this._client, item);
  }

  /** Lists historical versions of a file, following pagination. */
  async list_file_versions(drive_id: string, item_id: string): Promise<OneDriveFileVersion[]> {
    return await list_drive_item_versions(this._client, drive_id, item_id);
  }

  /** Downloads a specific version's content with size-based timeout. */
  async download_file_version(
    drive_id: string,
    item_id: string,
    version_id: string,
    size_bytes?: number,
  ): Promise<Buffer> {
    const stream = await this.open_version_stream(drive_id, item_id, version_id);
    // Never below the 120 s floor: the size only ever lengthens the drain timeout.
    const timeout_ms = Math.max(
      VERSION_DRAIN_TIMEOUT_MS,
      compute_chunk_timeout_ms(size_bytes ?? 0),
    );
    return await stream_to_buffer(stream, timeout_ms);
  }

  /** Opens a version's content as a stream, for sizes not safe to buffer. */
  async stream_file_version(
    drive_id: string,
    item_id: string,
    version_id: string,
  ): Promise<AsyncIterable<Buffer>> {
    const stream = await this.open_version_stream(drive_id, item_id, version_id);
    return stream instanceof Readable ? stream : Readable.from(stream as AsyncIterable<Buffer>);
  }

  private async open_version_stream(
    drive_id: string,
    item_id: string,
    version_id: string,
  ): Promise<NodeJS.ReadableStream> {
    const url = `/drives/${drive_id}/items/${item_id}/versions/${version_id}/content`;
    const stream = await with_graph_retry(() => get_graph_content_stream(this._client.api(url)));
    return stream as unknown as NodeJS.ReadableStream;
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
    file_system_info?: DriveFileSystemInfo,
  ): Promise<string | undefined> {
    return graph_onedrive_upload_small_file(
      this._client,
      owner_id,
      drive_id,
      parent_id,
      file_name,
      content,
      conflict_behavior,
      file_system_info,
    );
  }

  async upload_large_file(
    _tenant_id: string,
    owner_id: string,
    drive_id: string,
    parent_id: string,
    file_name: string,
    content: LargeFileContent,
    conflict_behavior?: string,
    file_system_info?: DriveFileSystemInfo,
  ): Promise<string | undefined> {
    return graph_onedrive_upload_large_file(
      this._client,
      owner_id,
      drive_id,
      parent_id,
      file_name,
      content,
      conflict_behavior,
      file_system_info,
    );
  }

  /** Reads non-inherited permissions for many items, 20 per `$batch` request. */
  async fetch_item_permissions(
    drive_id: string,
    item_ids: readonly string[],
  ): Promise<Map<string, DrivePermission[]>> {
    return this._sharing.fetch_item_permissions(drive_id, item_ids);
  }

  /** Grants direct access without an invitation email. */
  async grant_item_access(
    drive_id: string,
    item_id: string,
    request: DriveAccessGrantRequest,
  ): Promise<DriveSharingWriteOutcome> {
    return this._sharing.grant_item_access(drive_id, item_id, request);
  }

  /** Creates a sharing link of the stored type and scope. */
  async create_item_link(
    drive_id: string,
    item_id: string,
    request: DriveLinkRequest,
  ): Promise<DriveSharingWriteOutcome> {
    return this._sharing.create_item_link(drive_id, item_id, request);
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
      // 404 here means the drive does not exist, not that a grant is missing. Reporting it as a
      // permission fault sent operators to Entra to grant what they already had (issue #404).
      rethrow_if_no_onedrive(err, owner_id);
      throw err;
    }
    if (!default_drive.id) throw new NotFoundError(no_onedrive_message(owner_id));
    return [{ drive_id: default_drive.id, drive_name: default_drive.name ?? 'default' }];
  }
}
