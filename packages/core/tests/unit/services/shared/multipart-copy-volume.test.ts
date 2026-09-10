import { randomBytes } from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import { ByteQueue } from '@/services/shared/byte-queue';
import { stream_encrypt_to_multipart } from '@/services/shared/stream-encrypt-upload';

/**
 * Issue #343: the multipart helper concatenated everything still pending on every flush and copied
 * the remainder back, so the same 256 MiB payload cost 520 MiB of copying when it arrived in 4 MiB
 * chunks and 8,456 MiB when it arrived in one. Copy volume has to follow the payload, not the size
 * of the chunks it is delivered in.
 */

const PART_SIZE = 8 * 1024 * 1024;
const PAYLOAD_BYTES = 32 * 1024 * 1024;

function make_ctx(): { ctx: TenantContext; parts: Map<number, Buffer> } {
  const parts = new Map<number, Buffer>();
  const ctx = {
    storage: {
      begin_multipart_upload: vi.fn(async () => ({
        upload_part: vi.fn(async (part_number: number, data: Buffer) => {
          parts.set(part_number, Buffer.from(data));
          return `etag-${part_number}`;
        }),
        complete: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
      })),
      list_stale: vi.fn(async () => []),
      abort_incomplete_uploads: vi.fn(async () => 0),
    },
    create_cipher: stub_tenant_create_cipher,
  } as unknown as TenantContext;
  return { ctx, parts };
}

/** Bytes handed to `Buffer.concat`, which is the copying the flush path used to do per part. */
function measure_concat_bytes(): { total: () => number } {
  const spy = vi.spyOn(Buffer, 'concat');
  return {
    total: () =>
      spy.mock.calls.reduce(
        (sum, [list]) => sum + list.reduce((bytes, buf) => bytes + buf.length, 0),
        0,
      ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('multipart copy volume (issue #343)', () => {
  it.each([4 * 1024 * 1024, 16 * 1024 * 1024, PAYLOAD_BYTES])(
    'copies no more than one part when the payload arrives in %d byte chunks',
    async (chunk_size) => {
      const payload = randomBytes(PAYLOAD_BYTES);
      const { ctx } = make_ctx();
      const measured = measure_concat_bytes();

      await stream_encrypt_to_multipart(ctx, 'staging/object', {
        async *[Symbol.asyncIterator]() {
          for (let offset = 0; offset < payload.length; offset += chunk_size) {
            yield payload.subarray(offset, Math.min(offset + chunk_size, payload.length));
          }
        },
      });

      // The only concatenation left is the IV and auth tag onto part 1, which is bounded by the
      // part size no matter how large the object or the chunks it arrived in.
      expect(measured.total()).toBeLessThanOrEqual(PART_SIZE + 28);
    },
  );

  it('still assembles the parts in order and without gaps', async () => {
    const payload = randomBytes(PART_SIZE * 2 + 1024);
    const { ctx, parts } = make_ctx();

    await stream_encrypt_to_multipart(ctx, 'staging/object', {
      async *[Symbol.asyncIterator]() {
        yield payload;
      },
    });

    const assembled = [...parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, data]) => data)
      .reduce((total, part) => total + part.length, 0);
    // 12-byte IV and 16-byte tag ride in part 1 on top of the ciphertext, which GCM keeps the same
    // length as the plaintext.
    expect(assembled).toBe(payload.length + 28);
    expect(parts.get(1)!.length).toBe(PART_SIZE + 28);
  });
});

describe('ByteQueue', () => {
  it('hands out blocks that span the buffers they arrived in', () => {
    const queue = new ByteQueue();
    queue.push(Buffer.from([1, 2, 3]));
    queue.push(Buffer.from([4, 5]));
    queue.push(Buffer.from([6, 7, 8, 9]));

    expect(queue.take(4)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(queue.bytes).toBe(5);
    expect(queue.take(5)).toEqual(Buffer.from([5, 6, 7, 8, 9]));
    expect(queue.bytes).toBe(0);
  });

  it('refuses to hand out more than it holds', () => {
    const queue = new ByteQueue();
    queue.push(Buffer.from([1, 2]));

    expect(() => queue.take(3)).toThrow(/only 2 queued/);
  });
});
