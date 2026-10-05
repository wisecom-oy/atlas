/** Which part of the bucket layout a request touched; `bucket` for bucket-level commands. */
export type StorageRequestWorkload = 'outlook' | 'onedrive' | 'sharepoint' | 'shared' | 'bucket';

/** The kind of object a request touched, read from the key's leading path segments. */
export type StorageKeyClass =
  'data' | 'attachments' | 'manifests' | 'index' | 'staging' | '_meta' | 'other';

/**
 * One logical S3 request, reported after it settles.
 *
 * camelCase, matching `AtlasInstanceConfig`: the event is built once per request on the storage
 * hot path and handed to the host as-is, so it is never converted. It carries no object key,
 * bucket name, endpoint host or identifier; the host already knows the tenant, because an
 * instance belongs to one.
 */
export interface StorageRequestEvent {
  /** S3 operation, e.g. `PutObject`, `UploadPart`, `ListObjectsV2`. */
  readonly command: string;
  /** SDK method in progress, e.g. `backup`. Absent outside an SDK method. */
  readonly operation?: string;
  readonly workload: StorageRequestWorkload;
  readonly keyClass: StorageKeyClass;
  /** `primary`, or the `targetId` of the replication target that sent the request. */
  readonly target: string;
  /** When the request started, in epoch milliseconds. */
  readonly startTime: number;
  /** The whole logical request in milliseconds, including SDK retries and backoff. */
  readonly durationMs: number;
  /** Attempts the SDK made, including the first. */
  readonly attempts: number;
  /** Milliseconds the SDK slept between attempts. */
  readonly retryDelayMs: number;
  /**
   * Milliseconds spent waiting for a free connection in the SDK pool, summed over attempts.
   * Absent on Node releases without the `http.client.request.created` diagnostics channel
   * (before 22.12), where the split cannot be measured.
   */
  readonly socketWaitMs?: number;
  /**
   * Milliseconds from obtaining a connection to response headers, summed over attempts: connection
   * setup when the connection is new, the request body upload, and backend processing. Absent
   * where `socketWaitMs` is.
   */
  readonly networkMs?: number;
  /** Whether the final attempt reused a keep-alive connection. Absent where `socketWaitMs` is. */
  readonly connectionReused?: boolean;
  /** Request body length for uploads, or the response `ContentLength` for reads. */
  readonly bytes?: number;
  readonly statusCode?: number;
  /** Error name when the request failed, e.g. `SlowDown`, `NoSuchKey`, `TimeoutError`. */
  readonly errorType?: string;
}

/**
 * Receives one event per logical S3 request. Called synchronously on the storage path, so it
 * should only record; a throw or a rejected promise is ignored.
 */
export type StorageRequestObserver = (event: StorageRequestEvent) => void;
