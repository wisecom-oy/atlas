import { createCipheriv, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  OneDriveConnector,
  OneDriveDeltaItem,
  OneDriveFileVersion,
  TenantContext,
} from '@wisecom/atlas-types';
import { LARGE_FILE_THRESHOLD } from '@/services/backup/large-file-pipeline';
import { sync_file_versions } from '@/services/versioning/version-sync';

const KEY = randomBytes(32);

function make_item(overrides: Partial<OneDriveDeltaItem> = {}): OneDriveDeltaItem {
  return {
    item_id: 'item-1',
    drive_id: 'drive-1',
    file_name: 'file.bin',
    parent_path: '/docs',
    size_bytes: 1234,
    deleted: false,
    kind: 'file',
    ...overrides,
  } as OneDriveDeltaItem;
}

function make_version(size_bytes: number): OneDriveFileVersion {
  return {
    version_id: 'v1',
    size_bytes,
    last_modified_at: '2026-01-01T00:00:00Z',
  } as OneDriveFileVersion;
}

function make_ctx(): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: {
      exists: vi.fn().mockResolvedValue(false),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      copy: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
      begin_multipart_upload: vi.fn().mockResolvedValue({
        upload_part: vi.fn().mockResolvedValue('etag'),
        complete: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn().mockResolvedValue(undefined),
      }),
    },
    encrypt: vi.fn((data: Buffer) => data),
    create_cipher: () => {
      const iv = randomBytes(12);
      return { cipher: createCipheriv('aes-256-gcm', KEY, iv, { authTagLength: 16 }), iv };
    },
    destroy: vi.fn(),
  } as unknown as TenantContext;
}

/** A Graph error shaped the way `is_content_gone_error` recognises. */
function graph_status_error(status: number): Error {
  return Object.assign(new Error(`graph ${status}`), { statusCode: status });
}

describe('historical version content storage', () => {
  let ctx: TenantContext;
  const item = make_item();

  beforeEach(() => {
    ctx = make_ctx();
  });

  function make_connector(version: OneDriveFileVersion, overrides = {}): OneDriveConnector {
    return {
      list_file_versions: vi.fn().mockResolvedValue([version]),
      download_file_version: vi.fn().mockResolvedValue(Buffer.alloc(1024, 7)),
      stream_file_version: vi
        .fn()
        .mockResolvedValue(Readable.from([Buffer.alloc(1024, 7)]) as AsyncIterable<Buffer>),
      ...overrides,
    } as unknown as OneDriveConnector;
  }

  it('buffers a version below the streaming threshold', async () => {
    const version = make_version(LARGE_FILE_THRESHOLD - 1);
    const connector = make_connector(version);

    const outcome = await sync_file_versions(connector, item, 'owner-1', 'snap-1', ctx, undefined);

    expect(connector.download_file_version).toHaveBeenCalledTimes(1);
    expect(connector.stream_file_version).not.toHaveBeenCalled();
    expect(ctx.storage.put).toHaveBeenCalledTimes(1);
    expect(outcome.new_versions_stored).toBe(1);
  });

  it('streams a version at the threshold instead of buffering it', async () => {
    const version = make_version(LARGE_FILE_THRESHOLD);
    const connector = make_connector(version);

    const outcome = await sync_file_versions(connector, item, 'owner-1', 'snap-1', ctx, undefined);

    expect(connector.stream_file_version).toHaveBeenCalledTimes(1);
    expect(connector.download_file_version).not.toHaveBeenCalled();
    // A streamed object is assembled by multipart and promoted by copy; a
    // single `put` of the whole body is exactly what must not happen.
    expect(ctx.storage.put).not.toHaveBeenCalled();
    expect(ctx.storage.begin_multipart_upload).toHaveBeenCalledTimes(1);
    expect(ctx.storage.copy).toHaveBeenCalledTimes(1);
    expect(outcome.new_versions_stored).toBe(1);
  });

  it('records an expired streamed version as unavailable, not failed', async () => {
    const version = make_version(LARGE_FILE_THRESHOLD);
    const connector = make_connector(version, {
      stream_file_version: vi.fn().mockRejectedValue(graph_status_error(404)),
    });

    const outcome = await sync_file_versions(connector, item, 'owner-1', 'snap-1', ctx, undefined);

    expect(outcome.versions_unavailable).toBe(1);
    expect(outcome.versions_failed).toBe(0);
  });

  it('records a mid-stream Graph failure as failed, so the run retries it', async () => {
    const version = make_version(LARGE_FILE_THRESHOLD);
    async function* dies(): AsyncGenerator<Buffer> {
      yield Buffer.alloc(1024, 7);
      throw graph_status_error(503);
    }
    const connector = make_connector(version, {
      stream_file_version: vi.fn().mockResolvedValue(dies()),
    });

    const outcome = await sync_file_versions(connector, item, 'owner-1', 'snap-1', ctx, undefined);

    expect(outcome.versions_failed).toBe(1);
    // A failed version must not advance the watermark, or the next run skips it.
    expect(outcome.next_watermark).toBeUndefined();
  });

  it('propagates a storage failure instead of recording it as a Graph failure', async () => {
    const version = make_version(LARGE_FILE_THRESHOLD);
    const connector = make_connector(version);
    vi.mocked(ctx.storage.copy as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('bucket refused the copy'),
    );

    await expect(
      sync_file_versions(connector, item, 'owner-1', 'snap-1', ctx, undefined),
    ).rejects.toThrow('bucket refused the copy');
  });

  it('deduplicates a streamed version already present, without completing the upload', async () => {
    const version = make_version(LARGE_FILE_THRESHOLD);
    const connector = make_connector(version);
    const handle = {
      upload_part: vi.fn().mockResolvedValue('etag'),
      complete: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(ctx.storage.begin_multipart_upload as ReturnType<typeof vi.fn>).mockResolvedValue(
      handle,
    );
    vi.mocked(ctx.storage.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const outcome = await sync_file_versions(connector, item, 'owner-1', 'snap-1', ctx, undefined);

    expect(outcome.versions_deduplicated).toBe(1);
    expect(handle.abort).toHaveBeenCalledTimes(1);
    expect(handle.complete).not.toHaveBeenCalled();
  });
});
