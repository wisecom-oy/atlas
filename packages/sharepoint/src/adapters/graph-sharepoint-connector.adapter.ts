import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import { GRAPH_CLIENT_TOKEN, is_invalid_delta_error, with_graph_retry } from '@atlas/m365-graph';
import type {
  SharePointSiteConnector,
  SharePointSite,
  SharePointDocumentLibrary,
  SharePointDeltaItem,
  SharePointDeltaResult,
  SharePointFileVersion,
} from '@atlas/types';
import {
  fetch_initial_delta_page,
  type GraphCollectionResponse,
} from '@/adapters/graph-sharepoint-delta-fetch';
import { map_delta_item, type GraphDeltaDriveItem } from '@/adapters/graph-sharepoint-delta-mapper';
import {
  download_with_fallback,
  resolve_download_url as resolve_download_url_helper,
  rethrow_if_access_denied,
} from '@/adapters/graph-sharepoint-download-helpers';
import {
  graph_sharepoint_create_folder,
  graph_sharepoint_upload_small_file,
  graph_sharepoint_upload_large_file,
} from '@/adapters/graph-sharepoint-restore.adapter';
import { stream_to_buffer } from '@/adapters/graph-sharepoint-stream-utils';
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

interface GraphVersionRecord {
  id?: string;
  lastModifiedDateTime?: string;
  size?: number;
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

  /** Lists document libraries (drives) within a site. */
  async list_document_libraries(
    _tenant_id: string,
    site_id: string,
  ): Promise<SharePointDocumentLibrary[]> {
    try {
      const response = await with_graph_retry(
        () =>
          this._client.api(`/sites/${site_id}/drives?$select=id,name`).get() as Promise<
            GraphCollectionResponse<GraphDriveRecord>
          >,
      );
      return (response.value ?? [])
        .filter((drive) => Boolean(drive.id))
        .map((drive) => ({ drive_id: drive.id ?? '', drive_name: drive.name ?? '' }));
    } catch (err) {
      rethrow_if_access_denied(err);
      throw err;
    }
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

  /** Downloads file content with chunked download, expired-URL refresh, and Graph fallback. */
  async download_file_content(item: SharePointDeltaItem): Promise<Buffer> {
    return await download_with_fallback(this._client, item);
  }

  /** Resolves the temporary pre-authenticated download URL for a file. */
  async resolve_download_url(item: SharePointDeltaItem): Promise<string | undefined> {
    return await resolve_download_url_helper(this._client, item);
  }

  /** Lists historical versions of a file, following pagination. */
  async list_file_versions(drive_id: string, item_id: string): Promise<SharePointFileVersion[]> {
    const all_versions: SharePointFileVersion[] = [];
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

    if (all_versions.length === 0) return [];
    return all_versions.filter((v) => v.version_id !== '1');
  }

  /** Downloads a specific version's content with size-based timeout. */
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
    return await stream_to_buffer(stream, STREAM_TIMEOUT_MS);
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
  ): Promise<void> {
    await graph_sharepoint_upload_small_file(
      this._client,
      site_id,
      drive_id,
      parent_id,
      file_name,
      content,
      conflict_behavior,
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
  ): Promise<void> {
    await graph_sharepoint_upload_large_file(
      this._client,
      site_id,
      drive_id,
      parent_id,
      file_name,
      content,
      conflict_behavior,
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
