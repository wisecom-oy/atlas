import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphUnavailableError, ThrottledError, type TenantContext } from '@wisecom/atlas-types';
import { DownloadRefusedError } from '@wisecom/atlas-m365-graph';
import type { DriveDeltaItem } from '@/drive-ports';
import { download_with_retry } from '@/backup/download-retry';
import { DownloadSizeChangedError } from '@/backup/download-integrity';
import { process_drive_backup_file } from '@/backup/file-processor';
import { LARGE_FILE_THRESHOLD } from '@/backup/large-file-threshold';
import type { DriveLargeFileDeps } from '@/backup/large-file-pipeline';
import { TransferTimeoutError } from '@/backup/transfer-timeout';
import { TransientDownloadError } from '@/backup/transient-download-failure';
import { build_drive_storage_keys } from '@/shared/storage-keys';

// Issue #857: the download path used to return undefined for every failure it gave up on, so the
// caller could not tell an outage from a fault in the file and spent a ledger attempt either way.
// A failure outside the file now ends as a TransientDownloadError; the file's own still returns
// undefined.

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const SMALL_ITEM = {
  drive_id: 'drive-1',
  item_id: 'item-1',
  kind: 'file',
  file_name: 'report.docx',
  parent_path: '/',
  size_bytes: 10,
  deleted: false,
} as DriveDeltaItem;

const LARGE_ITEM = { ...SMALL_ITEM, size_bytes: LARGE_FILE_THRESHOLD } as DriveDeltaItem;

const DEPS: DriveLargeFileDeps = {
  keys: build_drive_storage_keys('onedrive'),
  fetch_chunks: () => {
    throw new Error('not reached');
  },
};

const outage = (): GraphUnavailableError =>
  new GraphUnavailableError('Graph kept failing', { retries: 12, elapsed_ms: 1 });

function connector_failing_with(err: unknown) {
  return {
    download_file_content: vi.fn().mockRejectedValue(err),
    resolve_download_url: vi.fn().mockRejectedValue(err),
  };
}

/** Runs the shared file processor for `item`, with fake timers covering the file-level backoff. */
async function process_file(item: DriveDeltaItem, err: unknown): Promise<unknown> {
  vi.useFakeTimers();
  const outcome = process_drive_backup_file(
    DEPS,
    connector_failing_with(err) as never,
    item,
    'owner-1',
    {} as TenantContext,
    vi.fn(),
  ).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return outcome;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('download_with_retry on a failure outside the file (issue #857)', () => {
  it('throws TransientDownloadError carrying the outage once its attempts are spent', async () => {
    const err = outage();
    const connector = connector_failing_with(err);

    const thrown = await download_with_retry(connector as never, SMALL_ITEM, { max_attempts: 1 })
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(thrown).toBeInstanceOf(TransientDownloadError);
    expect((thrown as Error).cause).toBe(err);
  });

  it('throws TransientDownloadError for a timeout without retrying it', async () => {
    const connector = connector_failing_with(new TransferTimeoutError('timed out'));

    await expect(download_with_retry(connector as never, SMALL_ITEM)).rejects.toBeInstanceOf(
      TransientDownloadError,
    );
    expect(connector.download_file_content).toHaveBeenCalledOnce();
  });
});

describe('process_drive_backup_file on the small-file path', () => {
  it.each([
    ['an exhausted Graph retry', outage()],
    ['an exhausted throttle', new ThrottledError('throttled', 1_000)],
    ['a connection reset', Object.assign(new Error('reset'), { code: 'ECONNRESET' })],
  ])('throws TransientDownloadError for %s', async (_label, err) => {
    const outcome = await process_file(SMALL_ITEM, err);

    expect(outcome).toEqual({ error: expect.any(TransientDownloadError) });
  });

  it('returns undefined for a Graph 404, which belongs to the file', async () => {
    const not_found = Object.assign(new Error('gone'), { statusCode: 404, code: 'itemNotFound' });

    expect(await process_file(SMALL_ITEM, not_found)).toEqual({ value: undefined });
  });

  it('still rethrows a refusal unchanged', async () => {
    const refused = new DownloadRefusedError('refused', 'malwareDetected');

    expect(await process_file(SMALL_ITEM, refused)).toEqual({ error: refused });
  });
});

describe('process_drive_backup_file on the large-file path', () => {
  it('throws TransientDownloadError when Graph is down while resolving the URL', async () => {
    const err = outage();
    const outcome = (await process_file(LARGE_ITEM, err)) as { error?: Error };

    expect(outcome.error).toBeInstanceOf(TransientDownloadError);
    expect(outcome.error?.cause).toBe(err);
  });

  it('returns undefined for a failure that belongs to the file', async () => {
    const size_changed = new DownloadSizeChangedError('size', LARGE_FILE_THRESHOLD, 1);
    // The size change is re-read once; the re-read finds the same size, so the file is skipped.
    const refetch = vi.fn().mockResolvedValue(LARGE_ITEM);
    const connector = connector_failing_with(size_changed);

    const outcome = await process_drive_backup_file(
      DEPS,
      connector as never,
      LARGE_ITEM,
      'owner-1',
      {} as TenantContext,
      refetch,
    );

    expect(outcome).toBeUndefined();
  });
});
