/**
 * A FIFO of buffers that hands out fixed-size blocks.
 *
 * Chunk sources and block consumers disagree on size: a ranged download arrives in 4 MiB pieces, a
 * Graph response stream in whatever the socket produced, and both S3 multipart parts and Graph
 * upload-session chunks have to go out at one fixed size. Concatenating the pending bytes on every
 * flush copies the remainder again for each block, so copy volume grew with the input chunk size
 * rather than with the payload (issue #343). Only the bytes actually handed out are copied here;
 * everything still pending stays in the buffers it arrived in.
 */
export class ByteQueue {
  private readonly _chunks: Buffer[] = [];
  private _bytes = 0;

  /** Bytes currently queued. */
  get bytes(): number {
    return this._bytes;
  }

  /**
   * Appends a chunk. Empty chunks are dropped rather than queued.
   *
   * The queue takes ownership: what is not handed out stays as a view into this buffer, so a caller
   * reusing a scratch buffer would change bytes already queued. Every caller today pushes a fresh
   * buffer, which is what `cipher.update` and a stream chunk both are.
   */
  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this._chunks.push(chunk);
    this._bytes += chunk.length;
  }

  /** Removes and returns exactly `size` bytes. Throws when fewer are queued. */
  take(size: number): Buffer {
    if (size > this._bytes) {
      throw new Error(`ByteQueue: asked for ${size} bytes, only ${this._bytes} queued`);
    }
    const block = Buffer.allocUnsafe(size);
    let filled = 0;
    while (filled < size) {
      const head = this._chunks[0]!;
      const wanted = size - filled;
      if (head.length <= wanted) {
        head.copy(block, filled);
        filled += head.length;
        this._chunks.shift();
        continue;
      }
      head.copy(block, filled, 0, wanted);
      this._chunks[0] = head.subarray(wanted);
      filled += wanted;
    }
    this._bytes -= size;
    return block;
  }
}
