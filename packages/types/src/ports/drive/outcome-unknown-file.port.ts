/**
 * A drive file whose upload ended without a clear answer, so it may exist in the target (issue
 * #893): a single-request upload sent once, or the final chunk of an upload session. Its line is in
 * `errors` too; this names which errors those are.
 */
export interface OutcomeUnknownFile {
  /** Where the file was being written: the target folder path and the file's name. */
  readonly path: string;
  /** The line reported for it in `errors`. */
  readonly error: string;
}
