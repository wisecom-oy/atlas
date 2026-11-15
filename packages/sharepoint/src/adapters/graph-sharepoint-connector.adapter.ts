import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import {
  list_drive_item_versions,
  GRAPH_CLIENT_TOKEN,
  is_invalid_delta_error,
  with_graph_retry,
} from '@wisecom/atlas-m365-graph';
import type {
  DriveAccessGrantRequest,
  DriveFolderColor,
  DriveFileSystemInfo,
  DriveLinkRequest,
  DrivePermission,
  DriveSharingConnector,
  DriveSharingWriteOutcome,
  LargeFileContent,
  SharePointSiteConnector,
  SharePointSite,
  SharePointDocumentLibrary,
  SharePointDeltaItem,
  SharePointDeltaResult,
  SharePointFileVersion,
  SharePointSubsiteTree,
} from '@wisecom/atlas-types';
import { enumerate_subsite_tree, fetch_direct_subsites } from '@/adapters/graph-subsite-enumerator';
import { list_tenant_sites, resolve_site_reference } from '@/adapters/graph-sharepoint-site-lookup';
import {
  execute_sharepoint_delta,
  fetch_drive_item_by_id,
  type GraphCollectionResponse,
} from '@/adapters/graph-sharepoint-delta-fetch';
import { has_item_id, map_delta_item } from '@/adapters/graph-sharepoint-delta-mapper';
import { create_graph_drive_sharing } from '@wisecom/atlas-drive/permissions/graph-drive-sharing';
import { fetch_drive_folder_colors } from '@wisecom/atlas-drive/graph/graph-folder-color-fetch';
import { SHAREPOINT_DOWNLOAD_EXECUTOR } from '@/adapters/graph-sharepoint-download-executor';
import {
  graph_sharepoint_create_folder,
  graph_sharepoint_upload_small_file,
  graph_sharepoint_upload_large_file,
} from '@/adapters/graph-sharepoint-restore.adapter';
import {
  as_buffer_iterable,
  open_version_content_stream,
} from '@/adapters/graph-sharepoint-stream-utils';
import { compute_chunk_timeout_ms } from '@wisecom/atlas-drive/backup/cdn-chunk-request';
import { stream_to_buffer } from '@wisecom/atlas-drive/backup/stream-drain';

interface GraphDriveRecord {
  id?: string;
  name?: string;
}

const STREAM_TIMEOUT_MS = 120_000;

/** Microsoft Graph adapter for SharePoint site backup via /sites API. */
@injectable()
export class GraphSharePointConnector implements SharePointSiteConnector {
  private readonly _sharing: DriveSharingConnector;

  constructor(@inject(GRAPH_CLIENT_TOKEN) private readonly _client: Client) {
    this._sharing = create_graph_drive_sharing(_client);
  }

  /** Lists all SharePoint sites in the tenant via search, flagging container sites by `kind`. */
  async list_sites(_tenant_id: string): Promise<SharePointSite[]> {
    return await list_tenant_sites(this._client);
  }

  /** Resolves a single site by URL path (hostname:/path), full URL, or site ID. */
  async resolve_site(_tenant_id: string, site_url_or_id: string): Promise<SharePointSite> {
    return await resolve_site_reference(this._client, site_url_or_id);
  }

  /** Recursively lists every subsite beneath a site. */
  async list_subsites(_tenant_id: string, site_id: string): Promise<SharePointSubsiteTree> {
    return enumerate_subsite_tree(site_id, (parent_site_id) =>
      fetch_direct_subsites(this._client, parent_site_id),
    );
  }

  /**
   * Lists document libraries (drives) within a site, following continuation
   * links: restore routing treats this list as the complete set of destinations,
   * so a truncated page would send files to the wrong library.
   */
  async list_document_libraries(
    _tenant_id: string,
    site_id: string,
  ): Promise<SharePointDocumentLibrary[]> {
    const libraries: SharePointDocumentLibrary[] = [];
    let next_url: string | undefined = `/sites/${site_id}/drives?$select=id,name`;

    try {
      while (next_url) {
        const url = next_url;
        // Retry wraps a single page, never the whole walk.
        const page: GraphCollectionResponse<GraphDriveRecord> = await with_graph_retry(
          () => this._client.api(url).get() as Promise<GraphCollectionResponse<GraphDriveRecord>>,
        );
        for (const drive of page.value ?? []) {
          if (!drive.id) continue;
          libraries.push({ drive_id: drive.id, drive_name: drive.name ?? '' });
        }
        next_url = page['@odata.nextLink'];
      }
    } catch (err) {
      await SHAREPOINT_DOWNLOAD_EXECUTOR.rethrow_if_access_denied(this._client, err, {
        label: `site ${site_id}`,
        site_id,
      });
      throw err;
    }

    return libraries;
  }

  /** Fetches delta changes since the last sync, with automatic reset handling. */
  async fetch_delta(
    _tenant_id: string,
    site_id: string,
    drive_id: string,
    prev_delta_link?: string,
  ): Promise<SharePointDeltaResult> {
    const library = { label: `library ${drive_id} of site ${site_id}`, site_id, drive_id };
    try {
      return await execute_sharepoint_delta(this._client, drive_id, prev_delta_link, false);
    } catch (err) {
      await SHAREPOINT_DOWNLOAD_EXECUTOR.rethrow_if_access_denied(this._client, err, library);
      if (!is_invalid_delta_error(err)) throw err;
    }
    // The full read after an expired cursor classifies a 403 the same way.
    try {
      return await execute_sharepoint_delta(this._client, drive_id, undefined, true);
    } catch (err) {
      await SHAREPOINT_DOWNLOAD_EXECUTOR.rethrow_if_access_denied(this._client, err, library);
      throw err;
    }
  }

  /** Re-fetches one item by id for failed-item retry; undefined once it is gone. */
  async fetch_item_by_id(
    _tenant_id: string,
    site_id: string,
    drive_id: string,
    item_id: string,
  ): Promise<SharePointDeltaItem | undefined> {
    try {
      const raw = await fetch_drive_item_by_id(this._client, drive_id, item_id);
      if (!raw || !has_item_id(raw)) return undefined;
      return map_delta_item(raw, drive_id);
    } catch (err) {
      await SHAREPOINT_DOWNLOAD_EXECUTOR.rethrow_if_access_denied(this._client, err, {
        label: `item ${item_id} in library ${drive_id}`,
        site_id,
        drive_id,
      });
      throw err;
    }
  }

  /** Downloads file content with chunked download, expired-URL refresh, and Graph fallback. */
  async download_file_content(
    item: SharePointDeltaItem,
    abort_signal?: AbortSignal,
  ): Promise<Buffer> {
    return await SHAREPOINT_DOWNLOAD_EXECUTOR.download_with_fallback(
      this._client,
      item,
      abort_signal,
    );
  }

  /** Resolves the temporary pre-authenticated download URL for a file. */
  async resolve_download_url(item: SharePointDeltaItem): Promise<string | undefined> {
    return await SHAREPOINT_DOWNLOAD_EXECUTOR.resolve_download_url(this._client, item);
  }

  /**
   * Lists a file's *historical* versions, following pagination.
   *
   * The newest entry is dropped: Graph returns versions newest-first, and its version-content
   * endpoint refuses the current version ("Getting the content of the current version is not
   * supported"), which surfaced as an HTTP 400 per new file and a `UNHEALTHY` run (issue #110).
   * Current content already reaches storage through the item-content path.
   *
   * Dropping by position rather than by id is deliberate: SharePoint numbers versions `1.0`, `2.0`,
   * ..., so comparing against a literal id silently matched nothing. This mirrors
   * `GraphOneDriveConnector.list_file_versions`.
   */
  /** Lists historical versions of a file, following pagination. */
  async list_file_versions(drive_id: string, item_id: string): Promise<SharePointFileVersion[]> {
    return await list_drive_item_versions(this._client, drive_id, item_id);
  }

  /** Downloads a specific version's content with a timeout scaled to its size. */
  async download_file_version(
    drive_id: string,
    item_id: string,
    version_id: string,
    size_bytes?: number,
  ): Promise<Buffer> {
    const stream = await open_version_content_stream(this._client, drive_id, item_id, version_id);
    // Never below the 120 s floor: the size only ever lengthens the drain timeout.
    const timeout_ms = Math.max(STREAM_TIMEOUT_MS, compute_chunk_timeout_ms(size_bytes ?? 0));
    return await stream_to_buffer(stream, timeout_ms);
  }

  /** Opens a version's content as a stream, for sizes not safe to buffer. */
  async stream_file_version(
    drive_id: string,
    item_id: string,
    version_id: string,
  ): Promise<AsyncIterable<Buffer>> {
    return as_buffer_iterable(
      await open_version_content_stream(this._client, drive_id, item_id, version_id),
    );
  }

  /** Creates a folder in a document library and returns its item ID. */
  async create_folder(
    _tenant_id: string,
    site_id: string,
    drive_id: string,
    parent_id: string,
    folder_name: string,
  ): Promise<string> {
    return graph_sharepoint_create_folder(this._client, site_id, drive_id, parent_id, folder_name);
  }

  /** Uploads a small file (< 4 MiB) to a document library. */
  async upload_small_file(
    _tenant_id: string,
    site_id: string,
    drive_id: string,
    parent_id: string,
    file_name: string,
    content: Buffer,
    conflict_behavior?: string,
    file_system_info?: DriveFileSystemInfo,
  ): Promise<string | undefined> {
    return graph_sharepoint_upload_small_file(
      this._client,
      site_id,
      drive_id,
      parent_id,
      file_name,
      content,
      conflict_behavior,
      file_system_info,
    );
  }

  /** Uploads a large file via resumable upload session. */
  async upload_large_file(
    _tenant_id: string,
    site_id: string,
    drive_id: string,
    parent_id: string,
    file_name: string,
    content: LargeFileContent,
    conflict_behavior?: string,
    file_system_info?: DriveFileSystemInfo,
  ): Promise<string | undefined> {
    return graph_sharepoint_upload_large_file(
      this._client,
      site_id,
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

  /** Reads folder colours from each folder's list item, 20 per `$batch` request. */
  async fetch_folder_colors(
    drive_id: string,
    item_ids: readonly string[],
  ): Promise<Map<string, DriveFolderColor>> {
    return fetch_drive_folder_colors(this._client, drive_id, item_ids);
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
}
