/** Fetch `Response` stand-ins for the CDN chunk downloader suites. */

/** Copies a buffer into a standalone ArrayBuffer, since Node pools small Buffers. */
export function to_array_buffer(body: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(body.byteLength);
  new Uint8Array(copy).set(body);
  return copy;
}

/** A response carrying `body`, with `Content-Range` on a 206 and any extra headers given. */
export function range_response(
  status: number,
  body = Buffer.alloc(0),
  range_start = 0,
  extra_headers: Record<string, string> = {},
): Response {
  const content_range = `bytes ${range_start}-${range_start + Math.max(body.length - 1, 0)}/*`;
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries(extra_headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  if (status === 206) headers['content-range'] = content_range;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string): string | null => headers[name.toLowerCase()] ?? null },
    arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(to_array_buffer(body)),
    text: (): Promise<string> => Promise.resolve(''),
    // The Range-ignored path cancels the body unread, and the streamed fallback iterates it.
    body: {
      cancel: (): Promise<void> => Promise.resolve(),
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        // Two parts, so the re-cut has to join across reads rather than pass one buffer through.
        yield new Uint8Array(body.subarray(0, Math.ceil(body.length / 2)));
        yield new Uint8Array(body.subarray(Math.ceil(body.length / 2)));
      },
    },
  } as unknown as Response;
}

/** A well-behaved CDN answer: exactly the requested range, read from the Range header. */
export function honest_range_response(init: { headers: Record<string, string> }): Response {
  const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers['Range'] ?? '')!;
  const body = Buffer.alloc(Number(end) - Number(start) + 1, 1);
  return range_response(206, body, Number(start));
}
