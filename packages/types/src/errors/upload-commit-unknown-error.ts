/**
 * Rejection of an upload session whose final chunk, the request that creates the file or
 * attachment, ended without a clear answer: a `5xx` other than a throttle, a timeout, or a dropped
 * connection (issues #891, #892). Microsoft 365 may have created the item although the upload did
 * not see it complete, so a restore names it as possibly present, distinct from a refused upload,
 * and the operator checks the target before restoring it again.
 */
export class UploadCommitUnknownError extends Error {
  constructor(
    /** The chunk's `Content-Range`, and what the session creates: `file` or `attachment`. */
    chunk: { readonly range: string; readonly item: string },
    /** How the final chunk ended, such as `HTTP 504` or a transport failure. */
    ending: string,
    options?: { cause?: unknown },
  ) {
    super(
      `outcome unknown, the ${chunk.item} may exist: the final upload chunk (${chunk.range}) ` +
        `ended with ${ending} after Microsoft 365 may have committed it. ` +
        `Check the target before restoring it again`,
      options,
    );
    this.name = 'UploadCommitUnknownError';
  }
}
