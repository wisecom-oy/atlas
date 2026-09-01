import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import {
  list_drive_item_versions,
  GRAPH_CLIENT_TOKEN,
  is_invalid_delta_error,
  with_graph_retry,
} from '@wisecom/atlas-m365-graph';
import type {
  DriveFileSystemInfo,
  DriveItemIdentity,
  SharePointSiteConnector,
  SharePointSite,
  SharePointDocumentLibrary,
  SharePointDeltaItem,
  SharePointDeltaResult,
  SharePointFileVersion,
  SharePointSubsiteTree,
} from '@wisecom/atlas-types';
import { enumerate_subsite_tree, fetch_direct_subsites } from '@/adapters/graph-subsite-enumerator';
import {
  fetch_drive_item_by_id,
  fetch_initial_delta_page,
  type GraphCollectionResponse,
} from '@/adapters/graph-sharepoint-delta-fetch';
import { map_delta_item, type GraphDeltaDriveItem } from '@/adapters/graph-sharepoint-delta-mapper';
import {
  download_with_fallback,
  resolve_download_url as resolve_download_url_helper,
  rethrow_if_access_denied,
} from '@/adapters/graph-sharepoint-download-executor';
import {
  graph_sharepoint_create_folder,
  graph_sharepoint_upload_small_file,
  graph_sharepoint_upload_large_file,
} from '@/adapters/graph-sharepoint-restore.adapter';
import {
  as_buffer_iterable,
  open_version_content_stream,
  stream_to_buffer,
} from '@/adapters/graph-sharepoint-stream-utils';
import { parse_site_reference } from '@/adapters/graph-sharepoint-url-parser';

interface GraphSiteRecord {
  id?: string;
  webUrl?: string;
  displayName?: string;
}

interface GraphDriveRecord {
  id?: string;
  name?: string;
}

const STREAM_TIMEOUT_MS = 120_000;

/** Microsoft Graph adapter for SharePoint site backup via /sites API. */
@injectable()
export class GraphSharePointConnector implements SharePointSiteConnector {
  constructor(@inject(GRAPH_CLIENT_TOKEN) private readonly _client: Client) {}

  /** Lists all SharePoint sites in the tenant via search. */
  async list_sites(_tenant_id: string): Promise<SharePointSite[]> {
    const sites: SharePointSite[] = [];
    let next_url: string | undefined;

    let page = await with_graph_retry(
      () =>
        this._client.api('/sites?search=*&$select=id,webUrl,displayName&$top=100').get() as Promise<
          GraphCollectionResponse<GraphSiteRecord>
        >,
    );

    while (true) {
      for (const raw of page.value ?? []) {
        if (!raw.id) continue;
        sites.push({
          site_id: raw.id,
          site_url: raw.webUrl ?? '',
          display_name: raw.displayName ?? '',
        });
      }

      next_url = page['@odata.nextLink'];
      if (!next_url) break;
      page = await with_graph_retry(
        () =>
          this._client.api(next_url!).get() as Promise<GraphCollectionResponse<GraphSiteRecord>>,
      );
    }

    return sites;
  }

  /** Resolves a single site by URL path (hostname:/path), full URL, or site ID. */
  async resolve_site(_tenant_id: string, site_url_or_id: string): Promise<SharePointSite> {
    const graph_ref = parse_site_reference(site_url_or_id);

    const raw = await with_graph_retry(
      () =>
        this._client
          .api(`/sites/${graph_ref}?$select=id,webUrl,displayName`)
          .get() as Promise<GraphSiteRecord>,
    );

    if (!raw.id) {
      throw new Error(`Failed to resolve SharePoint site: ${site_url_or_id}`);
    }

    return {
      site_id: raw.id,
      site_url: raw.webUrl ?? '',
      display_name: raw.displayName ?? '',
    };
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
      rethrow_if_access_denied(err);
      throw err;
    }

    return libraries;
  }

  /** Fetches delta changes since the last sync, with automatic reset handling. */
  async fetch_delta(
    _tenant_id: string,
    _site_id: string,
    drive_id: string,
    prev_delta_link?: string,
  ): Promise<SharePointDeltaResult> {
    try {
      return await this.execute_delta(drive_id, prev_delta_link, false);
    } catch (err) {
      rethrow_if_access_denied(err);
      if (is_invalid_delta_error(err)) {
        return await this.execute_delta(drive_id, undefined, true);
      }
      throw err;
    }
  }

  /** Re-fetches one item by id for failed-item retry; undefined once it is gone. */
  async fetch_item_by_id(
    _tenant_id: string,
    _site_id: string,
    drive_id: string,
    item_id: string,
  ): Promise<SharePointDeltaItem | undefined> {
    try {
      const raw = await fetch_drive_item_by_id(this._client, drive_id, item_id);
      if (!raw?.id) return undefined;
      return map_delta_item(raw, drive_id);
    } catch (err) {
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  /** Downloads file content with chunked download, expired-URL refresh, and Graph fallback. */
  async download_file_content(item: SharePointDeltaItem): Promise<Buffer> {
    return await download_with_fallback(this._client, item);
  }

  /** Resolves the temporary pre-authenticated download URL for a file. */
  async resolve_download_url(item: SharePointDeltaItem): Promise<string | undefined> {
    return await resolve_download_url_helper(this._client, item);
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

  /** Downloads a specific version's content with a timeout guard. */
  async download_file_version(
    drive_id: string,
    item_id: string,
    version_id: string,
  ): Promise<Buffer> {
    const stream = await open_version_content_stream(this._client, drive_id, item_id, version_id);
    return await stream_to_buffer(stream, STREAM_TIMEOUT_MS);
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
  ): Promise<void> {
    await graph_sharepoint_upload_small_file(
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
    content: Buffer,
    conflict_behavior?: string,
    file_system_info?: DriveFileSystemInfo,
  ): Promise<void> {
    await graph_sharepoint_upload_large_file(
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

  private async execute_delta(
    drive_id: string,
    prev_delta_link: string | undefined,
    reset_detected: boolean,
  ): Promise<SharePointDeltaResult> {
    const items: SharePointDeltaItem[] = [];
    let delta_link = '';

    const { page: initial_page, reset_detected: stale_reset } = await fetch_initial_delta_page(
      this._client,
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

    return {
      drive_id,
      delta_link,
      items,
      reset_detected: reset_detected || stale_reset,
    };
  }
}
