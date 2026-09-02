import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SharePointSiteConnector,
  SharePointDeltaItem,
  StorageObjectLockPolicy,
  TenantContext,
} from '@wisecom/atlas-types';

const chunk_mocks = vi.hoisted(() => ({ fetch_file_chunks: vi.fn() }));
vi.mock('@/services/backup/large-file-chunk-download', () => chunk_mocks);

const { cleanup_stale_staging, process_large_file } =
  await import('@/services/backup/large-file-pipeline');

const KEY = randomBytes(32);
const SITE = 'site-1';

interface Recorded {
  readonly ctx: TenantContext;
  readonly ops: string[];
  readonly copy_args: Array<{ from: string; to: string; policy: unknown }>;
}

function make_ctx(options: { exists?: boolean; list?: string[] } = {}): Recorded {
  const ops: string[] = [];
  const copy_args: Array<{ from: string; to: string; policy: unknown }> = [];

  const ctx = {
    tenant_id: 'tenant-1',
    storage: {
      begin_multipart_upload: vi.fn(async (key: string) => {
        ops.push(`begin:${key}`);
        return {
          upload_part: vi.fn(async () => 'etag'),
          complete: vi.fn(async () => {
            ops.push('complete');
          }),
          abort: vi.fn(async () => {
            ops.push('abort');
          }),
        };
      }),
      exists: vi.fn(async () => options.exists === true),
      copy: vi.fn(async (from: string, to: string, _meta: unknown, policy: unknown) => {
        ops.push('copy');
        copy_args.push({ from, to, policy });
      }),
      delete: vi.fn(async (key: string) => {
        ops.push(`delete:${key}`);
      }),
      list: vi.fn(async () => options.list ?? []),
      abort_incomplete_uploads: vi.fn(async () => 0),
    },
    create_cipher: () => {
      const iv = randomBytes(12);
      return { cipher: createCipheriv('aes-256-gcm', KEY, iv, { authTagLength: 16 }), iv };
    },
  } as unknown as TenantContext;

  return { ctx, ops, copy_args };
}

function make_item(overrides: Partial<SharePointDeltaItem> = {}): SharePointDeltaItem {
  return {
    item_id: 'item-1',
    drive_id: 'drive-1',
    kind: 'file',
    file_name: 'movie.mp4',
    parent_path: '/Videos',
    size_bytes: 400 * 1024 * 1024,
    deleted: false,
    ...overrides,
  } as SharePointDeltaItem;
}

function make_connector(url?: string): SharePointSiteConnector {
  return {
    resolve_download_url: vi.fn().mockResolvedValue(url),
  } as unknown as SharePointSiteConnector;
}

beforeEach(() => {
  vi.clearAllMocks();
  chunk_mocks.fetch_file_chunks.mockImplementation(async function* () {
    yield Buffer.alloc(1024, 7);
  });
});

describe('process_large_file', () => {
  it('uses the download URL the delta item already carries', async () => {
    const recorded = make_ctx();
    const connector = make_connector();

    await process_large_file(
      connector,
      make_item({ download_url: 'https://cdn.example/abc' }),
      SITE,
      recorded.ctx,
    );

    // Resolving again would spend a Graph request per large file for nothing.
    expect(connector.resolve_download_url).not.toHaveBeenCalled();
    expect(chunk_mocks.fetch_file_chunks).toHaveBeenCalledWith(
      'https://cdn.example/abc',
      400 * 1024 * 1024,
      'item-1',
    );
  });

  it('resolves the download URL when the delta item has none', async () => {
    const recorded = make_ctx();
    const connector = make_connector('https://cdn.example/resolved');

    await process_large_file(connector, make_item(), SITE, recorded.ctx);

    expect(connector.resolve_download_url).toHaveBeenCalledTimes(1);
    expect(chunk_mocks.fetch_file_chunks.mock.calls[0]?.[0]).toBe('https://cdn.example/resolved');
  });

  it('throws before starting an upload when the URL cannot be resolved', async () => {
    const recorded = make_ctx();

    await expect(
      process_large_file(make_connector(undefined), make_item(), SITE, recorded.ctx),
    ).rejects.toThrow(/Could not resolve download URL for large file item-1/);

    // A begun multipart upload with no bytes is an orphan that accrues cost.
    expect(recorded.ops).toEqual([]);
  });

  it('stores under a content-addressed key derived from the plaintext hash', async () => {
    const recorded = make_ctx();

    const result = await process_large_file(
      make_connector('https://cdn.example/abc'),
      make_item(),
      SITE,
      recorded.ctx,
    );

    expect(result.stored).toBe(true);
    expect(result.deduplicated).toBe(false);
    expect(result.storage_key).toContain(result.checksum);
    expect(recorded.copy_args[0]?.to).toBe(result.storage_key);
  });

  it('aborts instead of completing when the content is already stored', async () => {
    const recorded = make_ctx({ exists: true });

    const result = await process_large_file(
      make_connector('https://cdn.example/abc'),
      make_item(),
      SITE,
      recorded.ctx,
    );

    expect(result).toMatchObject({ stored: false, deduplicated: true });
    expect(recorded.ops).toContain('abort');
    expect(recorded.ops).not.toContain('complete');
    expect(recorded.ops).not.toContain('copy');
  });

  it('passes the Object Lock policy through to the canonical copy', async () => {
    const recorded = make_ctx();
    const policy: StorageObjectLockPolicy = {
      mode: 'COMPLIANCE',
      retain_until: '2030-01-01T00:00:00.000Z',
    };

    await process_large_file(
      make_connector('https://cdn.example/abc'),
      make_item(),
      SITE,
      recorded.ctx,
      policy,
    );

    // A retained object that is copied without its policy is unprotected data
    // reported as protected.
    expect(recorded.copy_args[0]?.policy).toBe(policy);
  });

  it('stages under the owner prefix, keeping the canonical key out of the way', async () => {
    const recorded = make_ctx();

    await process_large_file(
      make_connector('https://cdn.example/abc'),
      make_item(),
      SITE,
      recorded.ctx,
    );

    const begin = recorded.ops.find((op) => op.startsWith('begin:'))!;
    expect(begin).toContain('staging');
    expect(begin).toContain('item-1');
    expect(recorded.copy_args[0]?.from).toBe(begin.slice('begin:'.length));
  });
});

describe('cleanup_stale_staging', () => {
  it('deletes every leftover staging object', async () => {
    const recorded = make_ctx({ list: ['staging/o/a-1', 'staging/o/b-2'] });

    await cleanup_stale_staging(recorded.ctx, SITE);

    expect(recorded.ops).toContain('delete:staging/o/a-1');
    expect(recorded.ops).toContain('delete:staging/o/b-2');
  });

  it('keeps going when one delete fails', async () => {
    const recorded = make_ctx({ list: ['staging/o/a-1', 'staging/o/b-2'] });
    vi.mocked(recorded.ctx.storage.delete as ReturnType<typeof vi.fn>).mockImplementation(
      async (key: string) => {
        if (key.endsWith('a-1')) throw new Error('locked');
      },
    );

    await expect(cleanup_stale_staging(recorded.ctx, SITE)).resolves.toBeUndefined();
    expect(recorded.ctx.storage.delete).toHaveBeenCalledTimes(2);
  });

  it('aborts incomplete uploads under the staging prefix', async () => {
    const recorded = make_ctx();
    vi.mocked(
      recorded.ctx.storage.abort_incomplete_uploads as ReturnType<typeof vi.fn>,
    ).mockResolvedValue(3);

    await cleanup_stale_staging(recorded.ctx, SITE);

    const prefix = vi.mocked(recorded.ctx.storage.abort_incomplete_uploads).mock.calls[0]?.[0];
    expect(prefix).toContain('staging');
    expect(prefix).toContain(SITE);
  });

  it('does nothing to delete when no staging objects are left', async () => {
    const recorded = make_ctx({ list: [] });

    await cleanup_stale_staging(recorded.ctx, SITE);

    expect(recorded.ctx.storage.delete).not.toHaveBeenCalled();
  });
});
