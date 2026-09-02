/** Options for {@link stream_whole_file_in_chunks}. */
export interface WholeFileStreamOptions {
  /** Size of each yielded buffer; must be a positive integer. */
  readonly chunk_size_bytes: number;
  /**
   * Milliseconds allowed between two reads before the request is aborted.
   *
   * A server that sends headers and then stalls would otherwise hold the download forever, which
   * is the failure the Range path bounds per chunk (issue #198). The clock is reset on every
   * part, so a slow-but-moving transfer is never cut off.
   */
  readonly stall_timeout_ms: number;
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
  const { chunk_size_bytes, stall_timeout_ms } = options;
  if (!Number.isSafeInteger(chunk_size_bytes) || chunk_size_bytes <= 0) {
    throw new Error(`Invalid chunk size for the streamed download of ${item_id}`);
  }

  const controller = new AbortController();
  let timer = arm_stall_timer(controller, stall_timeout_ms, item_id);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} for the streamed download of ${item_id}`);
    }

    let pending: Buffer[] = [];
    let pending_bytes = 0;
    for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
      clearTimeout(timer);
      timer = arm_stall_timer(controller, stall_timeout_ms, item_id);
      pending.push(Buffer.from(part));
      pending_bytes += part.byteLength;
      while (pending_bytes >= chunk_size_bytes) {
        const joined = Buffer.concat(pending);
        yield joined.subarray(0, chunk_size_bytes);
        const rest = joined.subarray(chunk_size_bytes);
        pending = rest.length > 0 ? [rest] : [];
        pending_bytes = rest.length;
      }
    }
    if (pending_bytes > 0) yield Buffer.concat(pending);
  } finally {
    clearTimeout(timer);
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
