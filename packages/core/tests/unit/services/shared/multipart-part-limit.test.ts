import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import type * as part_plan from '@/services/shared/multipart-part-plan';
import { MultipartPartLimitError, PartLimitBreach } from '@/services/shared/multipart-part-plan';
import {
  stream_encrypt_to_multipart,
  stream_to_content_addressed_storage,
} from '@/services/shared/stream-encrypt-upload';

// Issue #925: how the stream applies the part plan. A real limit of 10,000 parts would need 78 GiB
// of test data to reach, so the plan is pinned to 3 parts here. The arithmetic at 10,000 parts is
// covered in multipart-part-plan.test.ts.

const TEST_PART_LIMIT = 3;

vi.mock('@/services/shared/multipart-part-plan', async (import_original) => {
  const actual = await import_original<typeof part_plan>();
  return {
    ...actual,
    plan_multipart_part_size: (listed_bytes: number) =>
      actual.plan_multipart_part_size(listed_bytes, TEST_PART_LIMIT),
    assert_stream_within_part_limit: (streamed_bytes: number, part_size_bytes: number) =>
      actual.assert_stream_within_part_limit(streamed_bytes, part_size_bytes, TEST_PART_LIMIT),
  };
});

const MIB = 1024 * 1024;
/** The stub cipher's header: a 12 byte IV and a 16 byte auth tag ahead of part 1's ciphertext. */
const HEADER_BYTES = 28;

interface RecordedUpload {
  readonly ctx: TenantContext;
  readonly ops: string[];
  readonly part_sizes: Map<number, number>;
}

function recording_ctx(): RecordedUpload {
  const ops: string[] = [];
  const part_sizes = new Map<number, number>();
  const ctx = {
    storage: {
      begin_multipart_upload: vi.fn(async () => {
        ops.push('begin');
        return {
          upload_part: vi.fn(async (part_number: number, data: Buffer) => {
            ops.push(`part:${part_number}`);
            part_sizes.set(part_number, data.length);
            return `etag-${part_number}`;
          }),
          complete: vi.fn(async () => ({})),
          abort: vi.fn(async () => {
            ops.push('abort');
          }),
        };
      }),
      exists: vi.fn(async () => false),
      copy: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
    create_cipher: stub_tenant_create_cipher,
    create_content_hmac: stub_tenant_create_content_hmac,
  } as unknown as TenantContext;
  return { ctx, ops, part_sizes };
}

/** A source that counts how many chunks were pulled from it. */
function counted_source(total_bytes: number, chunk_bytes = 4 * MIB) {
  const pulled = { chunks: 0 };
  const chunk = Buffer.alloc(chunk_bytes, 0x5a);
  async function* chunks(): AsyncGenerator<Buffer> {
    for (let sent = 0; sent < total_bytes; sent += chunk_bytes) {
      pulled.chunks++;
      yield sent + chunk_bytes <= total_bytes ? chunk : chunk.subarray(0, total_bytes - sent);
    }
  }
  return { pulled, chunks: chunks() };
}

async function settle(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (err: unknown) => err,
  );
}

describe('stream_encrypt_to_multipart and the part limit (issue #925)', () => {
  it('uses the part size planned from the listed size', async () => {
    const listed = TEST_PART_LIMIT * 8 * MIB + 1;
    const recorded = recording_ctx();
    const source = counted_source(listed);

    await stream_encrypt_to_multipart(recorded.ctx, 'staging/a', source.chunks, 'scope', listed);

    expect(recorded.part_sizes.get(1)).toBe(16 * MIB + HEADER_BYTES);
    expect(recorded.part_sizes.get(2)).toBe(8 * MIB + 1);
    expect(recorded.part_sizes.size).toBe(2);
  });

  it('refuses a file over the largest size before the upload starts or a byte is read', async () => {
    const listed = TEST_PART_LIMIT * 32 * MIB + 1;
    const recorded = recording_ctx();
    const source = counted_source(listed);

    const err = await settle(
      stream_encrypt_to_multipart(recorded.ctx, 'staging/a', source.chunks, 'scope', listed),
    );

    expect(err).toBeInstanceOf(MultipartPartLimitError);
    expect(err).toMatchObject({ breach: PartLimitBreach.LISTED_SIZE, part_limit: 3 });
    expect((err as Error).message).toContain('at most 3 parts per multipart upload');
    expect(recorded.ops).toEqual([]);
    expect(source.pulled.chunks).toBe(0);
  });

  it('stops a stream longer than its listed size before the part past the limit', async () => {
    const listed = 8 * MIB;
    const recorded = recording_ctx();
    const source = counted_source(TEST_PART_LIMIT * 8 * MIB + 4 * MIB);

    const err = await settle(
      stream_encrypt_to_multipart(recorded.ctx, 'staging/a', source.chunks, 'scope', listed),
    );

    expect(err).toMatchObject({
      breach: PartLimitBreach.STREAM_OVERFLOW,
      part_size_bytes: 8 * MIB,
    });
    expect(recorded.ops).toEqual(['begin', 'part:2', 'part:3', 'abort']);
    expect(Math.max(...recorded.part_sizes.keys())).toBeLessThanOrEqual(TEST_PART_LIMIT);
  });

  it('accepts a stream that fills every allowed part exactly', async () => {
    const bytes = TEST_PART_LIMIT * 8 * MIB;
    const recorded = recording_ctx();
    const source = counted_source(bytes);

    await stream_encrypt_to_multipart(recorded.ctx, 'staging/a', source.chunks, 'scope', bytes);

    expect([...recorded.part_sizes.keys()].sort()).toEqual([1, 2, 3]);
  });
});

describe('stream_to_content_addressed_storage and the part limit (issue #925)', () => {
  it('plans from the target listed size', async () => {
    const listed = TEST_PART_LIMIT * 8 * MIB + 1;
    const recorded = recording_ctx();

    await stream_to_content_addressed_storage(recorded.ctx, counted_source(listed).chunks, {
      staging_key: 'staging/a',
      build_data_key: (name) => `data/${name}`,
      data_scope: 'data/',
      listed_bytes: listed,
    });

    expect(recorded.part_sizes.get(1)).toBe(16 * MIB + HEADER_BYTES);
  });

  it('refuses before the upload starts, leaving nothing to abort', async () => {
    const recorded = recording_ctx();

    const err = await settle(
      stream_to_content_addressed_storage(recorded.ctx, counted_source(0).chunks, {
        staging_key: 'staging/a',
        build_data_key: (name) => `data/${name}`,
        data_scope: 'data/',
        listed_bytes: TEST_PART_LIMIT * 32 * MIB + 1,
      }),
    );

    expect(err).toMatchObject({ breach: PartLimitBreach.LISTED_SIZE });
    expect(recorded.ops).toEqual([]);
  });
});
