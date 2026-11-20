/**
 * Rejection of `MailboxConnector.fetch_mime` when Exchange answered with an error that is permanent
 * for this one message, such as `500 ErrorMimeContentConversionFailed` (issue #812). The JSON
 * payload stands in for the MIME and the folder still completes, because asking again returns the
 * same answer. Never escapes a backup run: the capture step records it against the message.
 */
export class MimeUnavailableError extends Error {
  constructor(
    message: string,
    /** The Graph error code Exchange returned, recorded in the manifest entry. */
    readonly graph_code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'MimeUnavailableError';
  }
}
