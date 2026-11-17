import { describe, expect, it, vi } from 'vitest';
import { DownloadRefusedError } from '@wisecom/atlas-m365-graph';
import type { DriveDeltaItem } from '@/drive-ports';
import { DownloadIntegrityError, DownloadSizeChangedError } from '@/backup/download-integrity';
import { attempt_with_size_refresh } from '@/backup/download-size-refresh';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const ITEM = {
  item_id: 'item-1',
  drive_id: 'drive-1',
  file_name: 'Message.msg',
  size_bytes: 100,
  deleted: false,
} as DriveDeltaItem;

const RESIZED = { ...ITEM, size_bytes: 150 } as DriveDeltaItem;

function size_error(planned: number, observed: number): DownloadSizeChangedError {
  return new DownloadSizeChangedError(
    `produced ${observed}, expected ${planned}`,
    planned,
    observed,
  );
}

describe('attempt_with_size_refresh (issue #759)', () => {
  it('returns the attempt result without re-reading the item when nothing fails', async () => {
    const refetch = vi.fn();
    const attempt = vi.fn().mockResolvedValue('stored');

    await expect(attempt_with_size_refresh(ITEM, refetch, attempt)).resolves.toBe('stored');
    expect(refetch).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledWith(ITEM);
  });

  it('retries once with the item as it is now, when the size moved', async () => {
    const refetch = vi.fn().mockResolvedValue(RESIZED);
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(size_error(100, 150))
      .mockResolvedValueOnce('stored');

    await expect(attempt_with_size_refresh(ITEM, refetch, attempt)).resolves.toBe('stored');
    expect(refetch).toHaveBeenCalledWith(ITEM);
    expect(attempt).toHaveBeenNthCalledWith(2, RESIZED);
  });

  it('passes a truncation failure through without re-reading the item', async () => {
    const refetch = vi.fn();
    const attempt = vi.fn().mockRejectedValue(new DownloadIntegrityError('short body'));

    await expect(attempt_with_size_refresh(ITEM, refetch, attempt)).rejects.toThrow('short body');
    expect(refetch).not.toHaveBeenCalled();
  });

  it('passes an unrelated failure through without re-reading the item', async () => {
    const refetch = vi.fn();
    const attempt = vi.fn().mockRejectedValue(new Error('HTTP 404'));

    await expect(attempt_with_size_refresh(ITEM, refetch, attempt)).rejects.toThrow('HTTP 404');
    expect(refetch).not.toHaveBeenCalled();
  });

  it('skips the file when the item is gone after the size change', async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    const attempt = vi.fn().mockRejectedValue(size_error(100, 150));

    await expect(attempt_with_size_refresh(ITEM, refetch, attempt)).resolves.toBeUndefined();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('stops at one refresh when the retry changes size again', async () => {
    const refetch = vi.fn().mockResolvedValue(RESIZED);
    const attempt = vi.fn().mockRejectedValue(size_error(100, 150));

    await expect(attempt_with_size_refresh(ITEM, refetch, attempt)).resolves.toBeUndefined();
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('rethrows a retry failure that is not a size change', async () => {
    const refetch = vi.fn().mockResolvedValue(RESIZED);
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(size_error(100, 150))
      .mockRejectedValueOnce(new DownloadIntegrityError('short body'));

    await expect(attempt_with_size_refresh(ITEM, refetch, attempt)).rejects.toThrow('short body');
  });

  it('rethrows a missing grant or refusal raised by the re-read', async () => {
    const refusal = new DownloadRefusedError('refused', 'notAllowed');
    const refetch = vi.fn().mockRejectedValue(refusal);
    const attempt = vi.fn().mockRejectedValue(size_error(100, 150));

    await expect(attempt_with_size_refresh(ITEM, refetch, attempt)).rejects.toBe(refusal);
  });

  it('skips the file when the re-read fails for an ordinary reason', async () => {
    const refetch = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const attempt = vi.fn().mockRejectedValue(size_error(100, 150));

    await expect(attempt_with_size_refresh(ITEM, refetch, attempt)).resolves.toBeUndefined();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('rethrows a cancellation instead of starting the re-read', async () => {
    const cancel = new AbortController();
    const refetch = vi.fn();
    const attempt = vi.fn(() => {
      cancel.abort(new Error('Run interrupted by Ctrl+C'));
      return Promise.reject(size_error(100, 150));
    });

    await expect(attempt_with_size_refresh(ITEM, refetch, attempt, cancel.signal)).rejects.toThrow(
      'Run interrupted by Ctrl+C',
    );
    expect(refetch).not.toHaveBeenCalled();
  });
});
