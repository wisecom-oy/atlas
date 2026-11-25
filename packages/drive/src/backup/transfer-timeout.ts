/**
 * Raised when a drive transfer ran out of time: a `/content` request that never answered, a body
 * that stopped arriving, or a streamed download that stalled between reads.
 *
 * It is typed, not a plain `Error`, so the failed-item ledger can tell a timed-out transfer from a
 * fault in the file. A plain `Error` read as the file's fault, so a download host that hung through
 * five runs used up the file's attempts (issue #857). The name is deliberately not `TimeoutError`:
 * `with_graph_retry` would then retry it, which this type is not meant to change.
 */
export class TransferTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransferTimeoutError';
  }
}
