import { afterEach, describe, expect, it, vi } from 'vitest';
import { download_with_retry } from '@/backup/download-retry';
import type { DriveContentConnector, DriveDeltaItem } from '@/drive-ports';

const ITEM = {
  drive_id: 'drive-1',
  item_id: 'item-1',
  kind: 'file',
  file_name: 'report.bin',
  parent_path: '/',
  size_bytes: 10,
  deleted: false,
} as DriveDeltaItem;

function connector_with(
  download: DriveContentConnector['download_file_content'],
): DriveContentConnector {
  return { download_file_content: download } as unknown as DriveContentConnector;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('download_with_retry', () => {
  it('hands the run signal to the connector, so the transfer itself can be cancelled', async () => {
    const download = vi.fn().mockResolvedValue(Buffer.from('body'));
    const cancel = new AbortController();

    await download_with_retry(connector_with(download), ITEM, { abort_signal: cancel.signal });

    expect(download).toHaveBeenCalledWith(ITEM, cancel.signal);
  });

  it('returns undefined for a file that keeps failing, so the caller records it', async () => {
    const download = vi.fn().mockRejectedValue(new Error('HTTP 404'));

    await expect(download_with_retry(connector_with(download), ITEM)).resolves.toBeUndefined();
  });

  it('rethrows a failure caused by cancellation instead of reporting a skipped file (issue #632)', async () => {
    const cancel = new AbortController();
    // The transfer is torn down by the cancel and rejects with whatever the transport says.
    const download = vi.fn(() => {
      cancel.abort(new Error('Run interrupted by Ctrl+C'));
      return Promise.reject(new Error('This operation was aborted'));
    });

    await expect(
      download_with_retry(connector_with(download), ITEM, { abort_signal: cancel.signal }),
    ).rejects.toThrow('Run interrupted by Ctrl+C');
    expect(download).toHaveBeenCalledOnce();
  });

  it('ends the file-level backoff when the run is cancelled during it', async () => {
    vi.useFakeTimers();
    const cancel = new AbortController();
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const download = vi.fn().mockRejectedValue(reset);

    const outcome = download_with_retry(connector_with(download), ITEM, {
      abort_signal: cancel.signal,
    }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(100);
    cancel.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(0);

    expect(((await outcome) as Error).message).toBe('Run interrupted by Ctrl+C');
    expect(download).toHaveBeenCalledOnce();
  });
});
