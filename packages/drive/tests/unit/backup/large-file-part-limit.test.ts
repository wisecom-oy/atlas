import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import {
  assert_stream_within_part_limit,
  is_listed_size_part_limit_refusal,
  max_streamed_object_bytes,
} from '@wisecom/atlas-core/services/shared/multipart-part-plan';
import type * as stream_upload from '@wisecom/atlas-core/services/shared/stream-encrypt-upload';
import { stream_to_content_addressed_storage } from '@wisecom/atlas-core/services/shared/stream-encrypt-upload';
import type { DriveContentConnector, DriveDeltaItem } from '@/drive-ports';
import { process_drive_backup_file } from '@/backup/file-processor';
import type { DriveDownloadUrlResolver, DriveLargeFileDeps } from '@/backup/large-file-pipeline';
import { build_drive_storage_keys } from '@/shared/storage-keys';

// Issue #925: a file too large for 10,000 parts uploaded 78 GiB and then failed. It is now refused
// before Graph or storage is touched, and the refusal reaches the caller to be recorded as
// permanent. A stream that outgrows its plan is the file's failure for this run.

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@wisecom/atlas-core/services/shared/stream-encrypt-upload', async (import_original) => {
  const actual = await import_original<typeof stream_upload>();
  return {
    ...actual,
    stream_to_content_addressed_storage: vi.fn(actual.stream_to_content_addressed_storage),
  };
});

function large_item(size_bytes: number): DriveDeltaItem {
  return {
    item_id: 'item-1',
    drive_id: 'drive-1',
    file_name: 'Archive.bin',
    parent_path: '/Documents',
    size_bytes,
    kind: 'file',
  } as DriveDeltaItem;
}

function recording_storage_ctx(): TenantContext {
  return {
    storage: {
      begin_multipart_upload: vi.fn(),
      exists: vi.fn(async () => false),
      copy: vi.fn(),
      delete: vi.fn(),
    },
    create_cipher: stub_tenant_create_cipher,
    create_content_hmac: stub_tenant_create_content_hmac,
  } as unknown as TenantContext;
}

function connector(): DriveContentConnector & DriveDownloadUrlResolver {
  return {
    resolve_download_url: vi.fn(async () => 'https://cdn.example.invalid/item-1'),
  } as unknown as DriveContentConnector & DriveDownloadUrlResolver;
}

function deps(): DriveLargeFileDeps {
  return { keys: build_drive_storage_keys('onedrive'), fetch_chunks: vi.fn() };
}

async function settle(promise: Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe('a large file and the multipart part limit (issue #925)', () => {
  it('refuses a file over the largest size before Graph or storage is asked anything', async () => {
    const ctx = recording_storage_ctx();
    const large_deps = deps();
    const graph = connector();
    const item = large_item(max_streamed_object_bytes() + 1);

    const outcome = await settle(
      process_drive_backup_file(large_deps, graph, item, 'owner-1', ctx, vi.fn()),
    );

    expect(is_listed_size_part_limit_refusal(outcome.error)).toBe(true);
    expect((outcome.error as Error).message).toContain('at most 10000 parts per multipart upload');
    expect(graph.resolve_download_url).not.toHaveBeenCalled();
    expect(large_deps.fetch_chunks).not.toHaveBeenCalled();
    expect(ctx.storage.begin_multipart_upload).not.toHaveBeenCalled();
  });

  it('passes the listed size to the stream so it plans the part size', async () => {
    const item = large_item(max_streamed_object_bytes());
    vi.mocked(stream_to_content_addressed_storage).mockResolvedValueOnce({
      checksum: 'c',
      storage_key: 'k',
      stored: true,
      deduplicated: false,
    });

    await process_drive_backup_file(
      deps(),
      connector(),
      item,
      'owner-1',
      recording_storage_ctx(),
      vi.fn(),
    );

    expect(vi.mocked(stream_to_content_addressed_storage).mock.calls[0]?.[2]).toMatchObject({
      listed_bytes: max_streamed_object_bytes(),
    });
  });

  it('fails the file for this run when its stream outgrew the plan', async () => {
    let overflow: unknown;
    try {
      assert_stream_within_part_limit(8 * 1024 * 1024 + 1, 8 * 1024 * 1024, 1);
    } catch (err) {
      overflow = err;
    }
    vi.mocked(stream_to_content_addressed_storage).mockRejectedValueOnce(overflow);

    const outcome = await settle(
      process_drive_backup_file(
        deps(),
        connector(),
        large_item(64 * 1024 * 1024),
        'owner-1',
        recording_storage_ctx(),
        vi.fn(),
      ),
    );

    expect(outcome).toEqual({ value: undefined });
  });
});
