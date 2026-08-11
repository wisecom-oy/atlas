export interface SharePointSite {
  readonly site_id: string;
  readonly site_url: string;
  readonly display_name: string;
}

/**
 * Result of walking a site's subsite tree. Subsites the application cannot
 * read are reported in `warnings` rather than silently dropped -- Graph
 * returns only the subsites the caller has access to, so an empty list and
 * an inaccessible subtree are otherwise indistinguishable.
 */
export interface SharePointSubsiteTree {
  readonly sites: SharePointSite[];
  readonly warnings: string[];
}

export interface SharePointDocumentLibrary {
  readonly drive_id: string;
  readonly drive_name: string;
}

export type SharePointDeltaItemKind = 'file' | 'folder';

export interface SharePointDeltaItem {
  readonly item_id: string;
  readonly drive_id: string;
  readonly kind: SharePointDeltaItemKind;
  readonly file_name: string;
  readonly parent_path: string;
  readonly web_url?: string;
  /** Graph package facet type (e.g. `oneNote`) when this item is a package root. */
  readonly package_type?: string | undefined;
  readonly size_bytes: number;
  readonly etag?: string;
  readonly last_modified_at?: string;
  readonly deleted: boolean;
  readonly download_url?: string;
}

export interface SharePointDeltaResult {
  readonly drive_id: string;
  readonly delta_link: string;
  readonly items: SharePointDeltaItem[];
  readonly reset_detected: boolean;
}

export interface SharePointFileVersion {
  readonly version_id: string;
  readonly last_modified_at: string;
  readonly size_bytes: number;
}

export interface SharePointSiteConnector {
  /** Lists all SharePoint sites in the tenant. */
  list_sites(tenant_id: string): Promise<SharePointSite[]>;

  /** Resolves a single site by URL path or site ID. */
  resolve_site(tenant_id: string, site_url_or_id: string): Promise<SharePointSite>;

  /** Recursively lists every subsite beneath a site (`GET /sites/{id}/sites`). */
  list_subsites(tenant_id: string, site_id: string): Promise<SharePointSubsiteTree>;

  /** Lists document libraries (drives) within a site. */
  list_document_libraries(tenant_id: string, site_id: string): Promise<SharePointDocumentLibrary[]>;

  /** Fetches delta changes since the last sync for a document library. */
  fetch_delta(
    tenant_id: string,
    site_id: string,
    drive_id: string,
    prev_delta_link?: string,
  ): Promise<SharePointDeltaResult>;

  /**
   * Fetches one item by id, for retrying a previously failed item that delta
   * will not re-present. Resolves undefined when the item no longer exists.
   */
  fetch_item_by_id(
    tenant_id: string,
    site_id: string,
    drive_id: string,
    item_id: string,
  ): Promise<SharePointDeltaItem | undefined>;

  /** Downloads full file content for small/medium files. */
  download_file_content(item: SharePointDeltaItem): Promise<Buffer>;

  /** Resolves the temporary download URL for chunked download. */
  resolve_download_url(item: SharePointDeltaItem): Promise<string | undefined>;

  /** Lists version history for a file. */
  list_file_versions(drive_id: string, item_id: string): Promise<SharePointFileVersion[]>;

  /** Downloads a specific historical version of a file. */
  download_file_version(drive_id: string, item_id: string, version_id: string): Promise<Buffer>;

  /** Creates a folder in a document library. Returns the folder's item ID. */
  create_folder(
    tenant_id: string,
    site_id: string,
    drive_id: string,
    parent_id: string,
    folder_name: string,
  ): Promise<string>;

  /** Uploads a small file (< 4 MiB) to a document library. */
  upload_small_file(
    tenant_id: string,
    site_id: string,
    drive_id: string,
    parent_id: string,
    file_name: string,
    content: Buffer,
    conflict_behavior?: string,
  ): Promise<void>;

  /** Uploads a large file via resumable upload session. */
  upload_large_file(
    tenant_id: string,
    site_id: string,
    drive_id: string,
    parent_id: string,
    file_name: string,
    content: Buffer,
    conflict_behavior?: string,
  ): Promise<void>;
}
