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

/** A multipart upload that was never completed or aborted. */
export interface StorageIncompleteUpload {
  readonly key: string;
  readonly upload_id: string;
}

export interface StorageUploadPage {
  /** False when the backend refused to list multipart uploads. */
  readonly visible: boolean;
  readonly uploads: readonly StorageIncompleteUpload[];
  readonly next?: StorageUploadCursor;
}

/**
 * One page of an upload's parts. `gone` means the upload completed or was aborted since it was
 * listed; `denied` means the credentials may list uploads but not their parts.
 */
export interface StoragePartsPage {
  readonly status: 'listed' | 'gone' | 'denied';
  /** Bytes held by the parts on this page. */
  readonly bytes: number;
  readonly next_part_marker?: string;
}

/**
 * Lists a tenant bucket's objects, versions and incomplete uploads with their sizes. Every method
 * makes exactly one request, so a caller can hold a run to a request allowance.
 */
export interface StorageInventory {
  /** One page of objects under a prefix. Two requests when a refused version listing falls back. */
  list_object_page(request: StorageListingRequest): Promise<StorageObjectPage>;

  /** One page of incomplete multipart uploads. */
  list_incomplete_upload_page(cursor?: StorageUploadCursor): Promise<StorageUploadPage>;

  /** One page of an incomplete upload's parts, from `part_marker` on. */
  list_upload_parts_page(
    upload: StorageIncompleteUpload,
    part_marker?: string,
  ): Promise<StoragePartsPage>;
}

/** Opens the inventory of a tenant's bucket on the primary storage. */
export type StorageInventoryFactory = (tenant_id: string) => StorageInventory;
