/**
 * A file handed to a resumable upload, either whole or as a stream.
 *
 * Graph needs the total length in every `Content-Range`, which a stream cannot report, so a
 * streamed source carries the length the manifest recorded alongside it. Restoring a large object
 * from a buffer meant holding the whole plaintext while it uploaded, which put restore's peak
 * memory at the size of the largest file in the backup (issue #343).
 */
export interface StreamedFileContent {
  readonly chunks: AsyncIterable<Buffer> | Iterable<Buffer>;
  readonly total_bytes: number;
}

/** Upload payload: a buffer for content already in hand, or a stream for content still arriving. */
export type LargeFileContent = Buffer | StreamedFileContent;
