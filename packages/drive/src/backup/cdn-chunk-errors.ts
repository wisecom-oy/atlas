/**
 * A response from a pre-authenticated download URL that could not be used, with the HTTP status it
 * carried. `status_code` (not the Graph SDK's `statusCode`) is how `classify_download_failure`
 * tells a CDN answer from a Graph one: a CDN 401 or 403 means the URL went stale.
 */
export class CdnHttpError extends Error {
  constructor(
    message: string,
    readonly status_code: number,
    readonly retry_after_ms?: number,
  ) {
    super(message);
    this.name = 'CdnHttpError';
  }
}

/**
 * A chunk that failed for good, after its retries or on a status not worth retrying.
 *
 * It carries the last attempt's HTTP status when there was one, and the attempt's error as
 * `cause`. The previous plain `Error` kept only the message, so an expired URL on a chunked
 * download was never refreshed and a refusal was never named (issue #632).
 */
export class ChunkDownloadError extends Error {
  /** HTTP status of the failing attempt, or undefined when it failed before any response. */
  readonly status_code: number | undefined;

  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'ChunkDownloadError';
    this.status_code = cause instanceof CdnHttpError ? cause.status_code : undefined;
  }
}

/**
 * Raised when the server answers a Range request with the whole file.
 *
 * It is a property of the server, not of the chunk, so the caller stops asking for ranges
 * entirely rather than re-discovering it once per chunk (issue #301).
 */
export class RangeIgnoredError extends Error {
  constructor() {
    super('Range header ignored');
    this.name = 'RangeIgnoredError';
  }
}
