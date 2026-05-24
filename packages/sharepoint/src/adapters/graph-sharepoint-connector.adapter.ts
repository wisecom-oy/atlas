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
import { logger } from '@atlas/core/utils/logger';
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

interface GraphCollectionResponse<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

interface GraphSiteRecord {
  id?: string;
  webUrl?: string;
  displayName?: string;
}

interface GraphDriveRecord {
  id?: string;
  name?: string;
}

interface GraphDeltaDriveItem {
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
    let page: GraphCollectionResponse<GraphDeltaDriveItem>;
    let delta_link = '';

    const stale_cursor = prev_delta_link && !prev_delta_link.includes('$select=');
    if (stale_cursor) {
      logger.warn(
        `Delta cursor for drive ${drive_id} predates field selection — performing fresh delta`,
      );
    }

    if (prev_delta_link && !stale_cursor) {
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
            .api(`/drives/${drive_id}/root/delta`)
            .select(DRIVE_DELTA_SELECT_FIELDS)
            .get() as Promise<GraphCollectionResponse<GraphDeltaDriveItem>>,
      );
    }

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

function map_delta_item(raw: GraphDeltaDriveItem, drive_id: string): SharePointDeltaItem {
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

/**
 * Converts a site URL, hostname:/path, or GUID to a Graph `/sites` reference.
 * - GUID-only: returned as-is
 * - `hostname:/path` format: returned as-is
 * - Full URL (https://...): parsed to `hostname:/path` form
 */
function parse_site_reference(input: string): string {
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      const path_part = url.pathname === '/' ? '' : `:${url.pathname}`;
      return `${url.hostname}${path_part}`;
    } catch {
      return input;
    }
  }
  return input;
}

async function stream_to_buffer(
  stream: NodeJS.ReadableStream,
  timeout_ms: number,
): Promise<Buffer> {
  const readable = stream as import('node:stream').Readable;
  const chunks: Buffer[] = [];
  const read_stream = async (): Promise<void> => {
    for await (const chunk of readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      read_stream(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          readable.destroy();
          reject(new Error('Graph content stream timed out'));
        }, timeout_ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}
