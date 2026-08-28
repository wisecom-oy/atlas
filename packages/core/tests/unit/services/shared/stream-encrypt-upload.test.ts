import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import {
  stream_encrypt_to_multipart,
  stream_to_content_addressed_storage,
} from '@/services/shared/stream-encrypt-upload';

const PART_SIZE = 8 * 1024 * 1024;
const KEY = randomBytes(32);

interface Recorded {
  readonly ctx: TenantContext;
  readonly parts: Map<number, Buffer>;
  readonly ops: string[];
  readonly completed: Array<Array<{ ETag: string; PartNumber: number }>>;
}

/**
 * A storage whose multipart handle keeps every uploaded part, so the assembled
 * layout can be asserted rather than inferred from call counts.
 */
function make_ctx(options: { exists?: boolean; copy_fails?: boolean } = {}): Recorded {
  const parts = new Map<number, Buffer>();
  const ops: string[] = [];
  const completed: Array<Array<{ ETag: string; PartNumber: number }>> = [];

  const ctx = {
    tenant_id: 'tenant-1',
    storage: {
      begin_multipart_upload: vi.fn(async (key: string) => {
        ops.push(`begin:${key}`);
        return {
          upload_part: vi.fn(async (part_number: number, data: Buffer) => {
            parts.set(part_number, Buffer.from(data));
            ops.push(`part:${part_number}:${data.length}`);
            return `etag-${part_number}`;
          }),
          complete: vi.fn(async (assembled: Array<{ ETag: string; PartNumber: number }>) => {
            completed.push(assembled);
            ops.push('complete');
          }),
          abort: vi.fn(async () => {
            ops.push('abort');
          }),
        };
      }),
      exists: vi.fn(async () => options.exists === true),
      copy: vi.fn(async (from: string, to: string) => {
        ops.push(`copy:${from}->${to}`);
        if (options.copy_fails === true) throw new Error('copy refused');
      }),
      delete: vi.fn(async (key: string) => {
        ops.push(`delete:${key}`);
      }),
      abort_incomplete_uploads: vi.fn(async () => 0),
    },
    create_cipher: () => {
      const iv = randomBytes(12);
      return { cipher: createCipheriv('aes-256-gcm', KEY, iv, { authTagLength: 16 }), iv };
    },
  } as unknown as TenantContext;

  return { ctx, parts, ops, completed };
}

async function* chunks_of(total_bytes: number, chunk_size: number): AsyncGenerator<Buffer> {
  let remaining = total_bytes;
  while (remaining > 0) {
    const size = Math.min(chunk_size, remaining);
    yield Buffer.alloc(size, 0xab);
    remaining -= size;
  }
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

describe('stream_encrypt_to_multipart', () => {
  it('hashes the plaintext, not the ciphertext', async () => {
    const plaintext = randomBytes(1024);
    const recorded = make_ctx();

    const result = await stream_encrypt_to_multipart(recorded.ctx, 'staging/a', {
      async *[Symbol.asyncIterator]() {
        yield plaintext;
      },
    });

    expect(result.checksum).toBe(sha256(plaintext));
  });

  it('writes an object smaller than one part as a single part', async () => {
    const recorded = make_ctx();

    const result = await stream_encrypt_to_multipart(
      recorded.ctx,
      'staging/a',
      chunks_of(1024, 1024),
    );

    expect(result.completed_parts).toHaveLength(1);
    expect(result.completed_parts[0]?.PartNumber).toBe(1);
  });

  it('prepends the IV and auth tag to part 1, uploaded last', async () => {
    const recorded = make_ctx();

    await stream_encrypt_to_multipart(
      recorded.ctx,
      'staging/a',
      chunks_of(PART_SIZE * 3, 1024 * 64),
    );

    // 12-byte IV + 16-byte auth tag ride ahead of the first part's ciphertext.
    expect(recorded.parts.get(1)?.length).toBe(28 + PART_SIZE);
    const part_uploads = recorded.ops.filter((op) => op.startsWith('part:'));
    expect(part_uploads.at(-1)).toBe(`part:1:${28 + PART_SIZE}`);
  });

  it('keeps every part except the last at the multipart minimum', async () => {
    const recorded = make_ctx();

    const result = await stream_encrypt_to_multipart(
      recorded.ctx,
      'staging/a',
      chunks_of(PART_SIZE * 2 + 1024, 1024 * 64),
    );

    const ordered = [...result.completed_parts].sort((a, b) => a.PartNumber - b.PartNumber);
    for (const part of ordered.slice(0, -1)) {
      expect(recorded.parts.get(part.PartNumber)!.length).toBeGreaterThanOrEqual(5 * 1024 * 1024);
    }
    expect(ordered.map((p) => p.PartNumber)).toEqual([1, 2, 3]);
  });

  it('aborts the upload when the source fails mid-stream', async () => {
    const recorded = make_ctx();
    async function* failing(): AsyncGenerator<Buffer> {
      yield Buffer.alloc(1024, 1);
      throw new Error('source died');
    }

    await expect(stream_encrypt_to_multipart(recorded.ctx, 'staging/a', failing())).rejects.toThrow(
      'source died',
    );
    expect(recorded.ops).toContain('abort');
    expect(recorded.ops).not.toContain('complete');
  });
});

describe('stream_to_content_addressed_storage', () => {
  const target = (staging_key = 'staging/a') => ({
    staging_key,
    staging_prefix: 'staging/',
    build_data_key: (checksum: string) => `data/${checksum}`,
  });

  it('promotes the staged object to its content-addressed key', async () => {
    const recorded = make_ctx();

    const result = await stream_to_content_addressed_storage(
      recorded.ctx,
      chunks_of(1024, 1024),
      target(),
    );

    expect(result).toMatchObject({ stored: true, deduplicated: false });
    expect(result.storage_key).toBe(`data/${result.checksum}`);
    expect(recorded.ops).toContain('complete');
    expect(recorded.ops).toContain(`copy:staging/a->data/${result.checksum}`);
    expect(recorded.ops).toContain('delete:staging/a');
  });

  it('aborts rather than completing when the content is already stored', async () => {
    const recorded = make_ctx({ exists: true });

    const result = await stream_to_content_addressed_storage(
      recorded.ctx,
      chunks_of(1024, 1024),
      target(),
    );

    expect(result).toMatchObject({ stored: false, deduplicated: true });
    expect(recorded.ops).toContain('abort');
    expect(recorded.ops).not.toContain('complete');
    expect(recorded.ops.some((op) => op.startsWith('copy:'))).toBe(false);
  });

  it('deletes the staged object when promotion fails, and rethrows', async () => {
    const recorded = make_ctx({ copy_fails: true });

    await expect(
      stream_to_content_addressed_storage(recorded.ctx, chunks_of(1024, 1024), target()),
    ).rejects.toThrow('copy refused');
    expect(recorded.ops).toContain('delete:staging/a');
  });
});
