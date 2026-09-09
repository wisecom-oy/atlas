/** Options for {@link stream_whole_file_in_chunks}. */
export interface WholeFileStreamOptions {
  /** Size of each yielded buffer; must be a positive integer. */
  readonly chunk_size_bytes: number;
  /**
   * Milliseconds allowed between two reads before the request is aborted.
   *
   * A server that sends headers and then stalls would otherwise hold the download forever, which
   * is the failure the Range path bounds per chunk (issue #198). The clock is reset on every
   * part, so a slow-but-moving transfer is never cut off, and it is disarmed while a chunk is in
   * the consumer's hands, so a busy consumer is not read as a stalled server (issue #344).
   */
  readonly stall_timeout_ms: number;
  /**
   * Cancellation from the caller, ending the request rather than the next item.
   *
   * A cancelled run used to wait out the whole body before it noticed, which for a multi-gigabyte
   * item is minutes of transfer nobody wants any more (issue #344).
   */
  readonly abort_signal?: AbortSignal | undefined;
}

/**
 * Streams an item in one request and cuts it into fixed-size buffers.
 *
 * The fallback for a server that ignores `Range` and answers with the whole file (issue #301).
 * Asking per chunk then costs the entire file every time, so a 1 GiB item moves 256 GiB to
 * produce 1 GiB. Cutting the single response into the same buffers the caller's
 * encrypt-and-upload pipeline expects keeps the memory ceiling at one chunk.
 */
export async function* stream_whole_file_in_chunks(
  url: string,
  item_id: string,
  options: WholeFileStreamOptions,
): AsyncGenerator<Buffer> {
  const { chunk_size_bytes, stall_timeout_ms, abort_signal } = options;
  if (!Number.isSafeInteger(chunk_size_bytes) || chunk_size_bytes <= 0) {
    throw new Error(`Invalid chunk size for the streamed download of ${item_id}`);
  }
  abort_signal?.throwIfAborted();

  const controller = new AbortController();
  let timer = arm_stall_timer(controller, stall_timeout_ms, item_id);

  try {
    const signal =
      abort_signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, abort_signal]);
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} for the streamed download of ${item_id}`);
    }

    let pending: Buffer[] = [];
    let pending_bytes = 0;
    for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
      // The read arrived, so the network is not what the timer would be measuring from here on.
      clearTimeout(timer);
      pending.push(Buffer.from(part));
      pending_bytes += part.byteLength;
      while (pending_bytes >= chunk_size_bytes) {
        const joined = Buffer.concat(pending);
        yield joined.subarray(0, chunk_size_bytes);
        const rest = joined.subarray(chunk_size_bytes);
        pending = rest.length > 0 ? [rest] : [];
        pending_bytes = rest.length;
      }
      // Armed again only now, when the loop goes back to waiting on the body.
      timer = arm_stall_timer(controller, stall_timeout_ms, item_id);
    }
    // The body is done, so the tail is handed over with no timer running behind it.
    clearTimeout(timer);
    if (pending_bytes > 0) yield Buffer.concat(pending);
  } finally {
    clearTimeout(timer);
    // A consumer that stopped early, because it failed or because the run was cancelled, leaves
    // the body half read. Aborting here closes the socket instead of leaving the transfer running
    // with nobody reading it (issue #344); after a completed body it does nothing.
    controller.abort();
  }
}

function arm_stall_timer(
  controller: AbortController,
  stall_timeout_ms: number,
  item_id: string,
): NodeJS.Timeout {
  return setTimeout(() => {
    controller.abort(new Error(`Streamed download of ${item_id} stalled`));
  }, stall_timeout_ms);
}
