/**
 * Issue #627: replication read each object whole into memory, wrote it with one PutObject (capped at
 * 5 GiB by S3), then downloaded it a second time only to count its bytes.
 *
 * A real object above 5 GiB cannot be exercised in a unit test, so the part size is shrunk to a few
 * bytes instead: the code path that carries a 6 GiB object in 16 MiB parts is the one that carries
 * a 23-byte object in 4-byte parts here.
 */

import { Readable } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import type { MultipartUploadHandle, ObjectStorage, TenantContext } from '@wisecom/atlas-types';
import {
  copy_objects_to_target,
  stream_object_to_target,
} from '@/services/replication/replication-object-copy';

const KEY = 'onedrive/data/owner-1/hash-1';

interface Rig {
  readonly source: ObjectStorage;
  readonly target: ObjectStorage;
  readonly handle: MultipartUploadHandle;
  /** Parts as uploaded, keyed by part number. */
  readonly parts: Map<number, Buffer>;
  /** Objects written to the target with a single put. */
  readonly puts: Map<string, Buffer>;
}

/** A source that serves `body` in `chunk_bytes` pieces, and a target that records what it gets. */
function make_rig(body: Buffer, chunk_bytes = 3, fail_part?: number): Rig {
  const parts = new Map<number, Buffer>();
  const puts = new Map<string, Buffer>();
  const chunks: Buffer[] = [];
  for (let i = 0; i < body.length; i += chunk_bytes) chunks.push(body.subarray(i, i + chunk_bytes));

  const handle: MultipartUploadHandle = {
    upload_part: vi.fn(async (part_number: number, data: Buffer) => {
      if (part_number === fail_part) throw new Error('SlowDown');
      parts.set(part_number, Buffer.from(data));
      return `"etag-${part_number}"`;
    }),
    complete: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
  const source = {
    get: vi.fn(async () => body),
    get_stream: vi.fn(async () => Readable.from(chunks)),
  } as unknown as ObjectStorage;
  const target = {
    exists: vi.fn(async (key: string) => puts.has(key)),
    put: vi.fn(async (key: string, data: Buffer) => {
      puts.set(key, data);
    }),
    begin_multipart_upload: vi.fn(async () => handle),
  } as unknown as ObjectStorage;
  return { source, target, handle, parts, puts };
}

function assembled(parts: Map<number, Buffer>): Buffer {
  return Buffer.concat([...parts.entries()].sort(([a], [b]) => a - b).map(([, data]) => data));
}

describe('stream_object_to_target (#627)', () => {
  it('uploads an object larger than one part as ordered multipart parts', async () => {
    const body = Buffer.from('abcdefghijklmnopqrstuvw');
    const rig = make_rig(body);

    const bytes = await stream_object_to_target(rig.source, rig.target, KEY, 4);

    expect(bytes).toBe(body.length);
    expect(rig.target.put).not.toHaveBeenCalled();
    expect([...rig.parts.values()].map((p) => p.length)).toEqual([4, 4, 4, 4, 4, 3]);
    expect(assembled(rig.parts)).toEqual(body);
    expect(rig.handle.complete).toHaveBeenCalledWith(
      [1, 2, 3, 4, 5, 6].map((n) => ({ ETag: `"etag-${n}"`, PartNumber: n })),
    );
  });

  it('reads the source exactly once and never buffers it whole', async () => {
    const rig = make_rig(Buffer.alloc(40, 7));

    await stream_object_to_target(rig.source, rig.target, KEY, 8);

    expect(rig.source.get_stream).toHaveBeenCalledTimes(1);
    expect(rig.source.get).not.toHaveBeenCalled();
  });

  it('writes an object of exactly one part with a single put', async () => {
    const body = Buffer.from('abcd');
    const rig = make_rig(body);

    expect(await stream_object_to_target(rig.source, rig.target, KEY, 4)).toBe(4);
    expect(rig.target.begin_multipart_upload).not.toHaveBeenCalled();
    expect(rig.puts.get(KEY)).toEqual(body);
  });

  it('writes an empty object with a single put', async () => {
    const rig = make_rig(Buffer.alloc(0));

    expect(await stream_object_to_target(rig.source, rig.target, KEY, 4)).toBe(0);
    expect(rig.puts.get(KEY)).toEqual(Buffer.alloc(0));
  });

  it('aborts the multipart upload when a part fails, and rethrows', async () => {
    const rig = make_rig(Buffer.alloc(20, 1), 3, 2);

    await expect(stream_object_to_target(rig.source, rig.target, KEY, 4)).rejects.toThrow(
      'SlowDown',
    );
    expect(rig.handle.abort).toHaveBeenCalledTimes(1);
    expect(rig.handle.complete).not.toHaveBeenCalled();
  });
});

describe('copy_objects_to_target (#627)', () => {
  function ctx(storage: ObjectStorage): TenantContext {
    return { tenant_id: 'tenant-1', storage } as unknown as TenantContext;
  }

  it('counts bytes from the single read rather than a second download', async () => {
    const body = Buffer.alloc(19, 9);
    const rig = make_rig(body);

    const tally = await copy_objects_to_target(ctx(rig.source), ctx(rig.target), [KEY], 4);

    expect(tally.objects_copied).toBe(1);
    expect(tally.bytes_copied).toBe(19);
    expect(rig.source.get_stream).toHaveBeenCalledTimes(1);
    expect(rig.source.get).not.toHaveBeenCalled();
  });

  it('skips a key the target already holds without reading the source', async () => {
    const rig = make_rig(Buffer.from('x'));
    rig.puts.set(KEY, Buffer.from('x'));

    const tally = await copy_objects_to_target(ctx(rig.source), ctx(rig.target), [KEY], 4);

    expect(tally.objects_skipped).toBe(1);
    expect(tally.bytes_copied).toBe(0);
    expect(rig.source.get_stream).not.toHaveBeenCalled();
  });

  it('reports a failed copy with its key and counts no bytes for it', async () => {
    const rig = make_rig(Buffer.alloc(12, 2), 3, 1);

    const tally = await copy_objects_to_target(ctx(rig.source), ctx(rig.target), [KEY], 4);

    expect(tally.objects_failed).toBe(1);
    expect(tally.bytes_copied).toBe(0);
    expect(tally.errors).toEqual([`${KEY}: SlowDown`]);
    expect(tally.object_results).toEqual([
      { storage_key: KEY, outcome: 'failed', error: 'SlowDown' },
    ]);
  });
});
