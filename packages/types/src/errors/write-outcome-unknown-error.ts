/**
 * A restore write Atlas sent once that ended without a clear answer, so Microsoft 365 may have
 * committed it (issue #893). A restore names the item as possibly present in the target, distinct
 * from an item Graph refused, and the operator checks the target before restoring it again.
 *
 * `UploadCommitUnknownError`, a final upload chunk that ended this way, is one; `CreateOutcomeUnknownError`,
 * a create request sent once, is the other. Test for this base class to catch both.
 */
export class WriteOutcomeUnknownError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * A create request sent once, such as a message create POST or a drive PUT under `rename`, that
 * ended with a `408`, a `500`, `502` or `504`, a `503` without `Retry-After`, a `509`, a `2xx` whose
 * body did not parse, a timeout, or a dropped connection. Graph can commit such a request and still
 * answer that way, and repeating it would leave a second copy, so it is reported rather than resent.
 */
export class CreateOutcomeUnknownError extends WriteOutcomeUnknownError {
  constructor(
    /** How the request ended, such as `HTTP 504` or a transport failure. */
    ending: string,
    options?: { cause?: unknown },
  ) {
    super(
      `outcome unknown, the item may exist: the create request ended with ${ending} after ` +
        'Microsoft 365 may have committed it. Check the target before restoring it again',
      options,
    );
  }
}

/**
 * Rejection of an upload session whose final chunk, the request that creates the file or
 * attachment, ended without a clear answer: a `5xx` other than a throttle, a timeout, or a dropped
 * connection (issues #891, #892). Microsoft 365 may have created the item although the upload did
 * not see it complete, so a restore names it as possibly present, distinct from a refused upload,
 * and the operator checks the target before restoring it again. A `WriteOutcomeUnknownError`, like a
 * create request sent once that ended the same way (issue #893).
 */
export class UploadCommitUnknownError extends WriteOutcomeUnknownError {
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
