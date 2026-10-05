/**
 * `versions` lists every version and delete marker. `current` lists live objects only, for
 * credentials that may not list versions.
 */
export type StorageListingMode = 'versions' | 'current';

/** Where a paginated listing resumes. Opaque to callers; only the adapter reads the fields. */
export interface StorageListingCursor {
  readonly key_marker?: string | undefined;
  readonly version_id_marker?: string | undefined;
  readonly continuation_token?: string | undefined;
}

export interface StorageListingRequest {
  readonly prefix: string;
  /** Groups keys below the next `/` into `common_prefixes` instead of listing them. */
  readonly delimiter?: string | undefined;
  readonly mode: StorageListingMode;
  readonly cursor?: StorageListingCursor | undefined;
}

export interface StorageListedObject {
  readonly key: string;
  readonly size: number;
  readonly is_latest: boolean;
  readonly is_delete_marker: boolean;
}

export interface StorageObjectPage {
  /**
   * The listing that produced the page. `current` on a `versions` request means the backend
   * refused to list versions and the adapter listed live objects instead.
   */
  readonly mode: StorageListingMode;
  readonly objects: readonly StorageListedObject[];
  readonly common_prefixes: readonly string[];
  /** Requests the page took: two when a refused version listing fell back. */
  readonly requests: number;
  readonly next?: StorageListingCursor;
}

export interface StorageUploadCursor {
  readonly key_marker?: string | undefined;
  readonly upload_id_marker?: string | undefined;
}

export interface StorageIncompleteUpload {
  readonly key: string;
  readonly bytes: number;
}

export interface StorageUploadPage {
  /** False when the backend refused to list multipart uploads. */
  readonly visible: boolean;
  readonly uploads: readonly StorageIncompleteUpload[];
  /** Requests the page took: the upload listing plus one parts listing per upload page. */
  readonly requests: number;
  readonly next?: StorageUploadCursor;
}

/** Lists a tenant bucket's objects, versions and incomplete uploads with their sizes. */
export interface StorageInventory {
  /** One page of objects under a prefix. */
  list_object_page(request: StorageListingRequest): Promise<StorageObjectPage>;

  /** One page of incomplete multipart uploads, each with the bytes its parts hold. */
  list_incomplete_upload_page(cursor?: StorageUploadCursor): Promise<StorageUploadPage>;
}

/** Opens the inventory of a tenant's bucket on the primary storage. */
export type StorageInventoryFactory = (tenant_id: string) => StorageInventory;
