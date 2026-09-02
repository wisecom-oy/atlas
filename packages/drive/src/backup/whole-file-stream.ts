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
  chunk_size_bytes: number,
): AsyncGenerator<Buffer> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} for the streamed download of ${item_id}`);
  }

  let pending: Buffer[] = [];
  let pending_bytes = 0;
  for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
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
}
