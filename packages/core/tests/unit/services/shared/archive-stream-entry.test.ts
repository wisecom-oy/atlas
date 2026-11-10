import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { read_zip_entries } from '@wisecom/atlas-types/testing/zip-entry-reader';
import {
  add_stream_to_archive,
  ArchiveEntryAbortedError,
} from '@/services/shared/archive-stream-entry';
import {
  ArchiveDestinationError,
  create_file_archive,
  finalize_file_archive,
} from '@/services/shared/file-save-zip-writer';

const CHUNK_BYTES = 64 * 1024;

/** Yields `count` random chunks, recording how many the consumer has pulled so far. */
function counted_source(chunks: Buffer[]): {
  source: AsyncGenerator<Buffer>;
  pulled: () => number;
} {
  let pulled = 0;
  async function* generate(): AsyncGenerator<Buffer> {
    for (const chunk of chunks) {
      pulled++;
      yield chunk;
    }
  }
  return { source: generate(), pulled: () => pulled };
}

function random_chunks(count: number): Buffer[] {
  return Array.from({ length: count }, () => randomBytes(CHUNK_BYTES));
}

function collect(stream: PassThrough): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => resolve(Buffer.concat(chunks)));
  stream.on('error', reject);
  return promise;
}

describe('add_stream_to_archive', () => {
  it('writes a multi-chunk source as one entry under its folder path', async () => {
    const chunks = random_chunks(40);
    const sink = new PassThrough();
    const received = collect(sink);
    const file_archive = create_file_archive(sink);

    await add_stream_to_archive(
      file_archive,
      '/Documents',
      'large.bin',
      counted_source(chunks).source,
    );
    await finalize_file_archive(file_archive.archive);
    await file_archive.promise;

    const entries = read_zip_entries(await received);
    expect([...entries.keys()]).toEqual(['Documents/large.bin']);
    expect(entries.get('Documents/large.bin')!.equals(Buffer.concat(chunks))).toBe(true);
  });

  it('pulls the source only as fast as the destination drains (issue #617)', async () => {
    const chunks = random_chunks(256);
    const { source, pulled } = counted_source(chunks);
    // Accepts one write and never acknowledges it, the way a stalled consumer behaves.
    const stalled = new Writable({ highWaterMark: CHUNK_BYTES, write: () => undefined });
    const file_archive = create_file_archive(stalled);

    const pending = add_stream_to_archive(file_archive, '/', 'large.bin', source);
    pending.catch(() => undefined);
    await delay(200);

    // Buffering the whole source would have pulled all 256 chunks (16 MiB) before writing.
    expect(pulled()).toBeGreaterThan(0);
    expect(pulled()).toBeLessThan(chunks.length / 4);
    await file_archive.abort();
  });

  it('abandons the archive when the source fails mid-entry instead of closing the entry', async () => {
    async function* failing(): AsyncGenerator<Buffer> {
      yield randomBytes(CHUNK_BYTES);
      throw new Error('Checksum mismatch for large.bin');
    }
    const sink = new PassThrough();
    sink.resume();
    const file_archive = create_file_archive(sink);

    const result = add_stream_to_archive(file_archive, '/', 'large.bin', failing());

    await expect(result).rejects.toBeInstanceOf(ArchiveEntryAbortedError);
    await expect(result).rejects.toThrow(/large\.bin.*Checksum mismatch/);
    await file_archive.abort();
  });

  it('keeps a lost destination as an ArchiveDestinationError', async () => {
    const sink = new PassThrough();
    const file_archive = create_file_archive(sink);
    sink.destroy(new Error('EPIPE'));

    const result = add_stream_to_archive(
      file_archive,
      '/',
      'large.bin',
      counted_source(random_chunks(4)).source,
    );

    await expect(result).rejects.toBeInstanceOf(ArchiveDestinationError);
    await file_archive.abort();
  });
});
