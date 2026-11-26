import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { binary_graph_response } from '@wisecom/atlas-types/testing/queued-graph-fetch';
import { download_with_retry } from '@/backup/download-retry';
import { process_drive_backup_file } from '@/backup/file-processor';
import { TransferTimeoutError } from '@/backup/transfer-timeout';
import { TransientDownloadError } from '@/backup/transient-download-failure';
import { build_drive_storage_keys } from '@/shared/storage-keys';
import {
  chunk_downloader,
  content_client_rig,
  drive_bindings,
  drive_file,
  executor_connector,
  stalled_body_response,
  stalled_request,
  type ContentAnswer,
} from './content-fallback.fixtures';

// Issue #890: a /content request that stalled raised a plain Error no retry layer knew, so the file
// failed after one attempt, and the timed-out request stayed open beside the next one. The timeout
// is now a TransferTimeoutError, the request is aborted when it fires, and the file-level loop gives
// the file its 3 attempts. `with_graph_retry` is the real one throughout.

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const BODY = Buffer.from('file-body');
/** No download URL in the listing and none from the lookup, so the file goes straight to /content. */
const ITEM = drive_file(BODY.length);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each(drive_bindings(chunk_downloader(vi.fn())))(
  'the /content fallback bound to %s (issue #890)',
  (_label, binding) => {
    /** Runs the file-level download with the stand-in answering `/content` with `content`. */
    function download(content: ContentAnswer, abort_signal?: AbortSignal) {
      const rig = content_client_rig(content);
      const connector = executor_connector(binding, rig.client);
      const outcome = download_with_retry(connector, ITEM, { abort_signal }).catch(
        (err: unknown) => err,
      );
      return { rig, outcome };
    }

    it('aborts a request that times out before the next attempt is sent', async () => {
      const aborted_when_next_sent: boolean[] = [];
      const { rig, outcome } = download((signal) => {
        aborted_when_next_sent.push(rig.request_signals.slice(0, -1).every((s) => s.aborted));
        return stalled_request(signal);
      });
      await vi.runAllTimersAsync();

      const failure = await outcome;
      expect(failure).toBeInstanceOf(TransientDownloadError);
      expect((failure as Error).cause).toBeInstanceOf(TransferTimeoutError);
      expect(rig.content_requests).toHaveBeenCalledTimes(3);
      expect(aborted_when_next_sent).toEqual([true, true, true]);
      expect(rig.request_signals.every((signal) => signal.aborted)).toBe(true);
    });

    it('stores the file when the attempt after a timed-out request succeeds', async () => {
      const { rig, outcome } = download((signal) =>
        rig.content_requests.mock.calls.length === 1
          ? stalled_request(signal)
          : Promise.resolve(binary_graph_response(BODY)),
      );
      await vi.runAllTimersAsync();

      expect(await outcome).toEqual(BODY);
      expect(rig.content_requests).toHaveBeenCalledTimes(2);
    });

    it('retries a body that stops arriving, up to the 3 file-level attempts', async () => {
      const { rig, outcome } = download(() => Promise.resolve(stalled_body_response()));
      await vi.runAllTimersAsync();

      const failure = await outcome;
      expect(failure).toBeInstanceOf(TransientDownloadError);
      expect((failure as Error).cause).toBeInstanceOf(TransferTimeoutError);
      expect(rig.content_requests).toHaveBeenCalledTimes(3);
    });

    it('aborts the pending request and stops without retrying when the run is cancelled', async () => {
      const cancel = new AbortController();
      const { rig, outcome } = download(stalled_request, cancel.signal);
      await vi.advanceTimersByTimeAsync(1_000);
      cancel.abort(new Error('Run interrupted by Ctrl+C'));
      await vi.runAllTimersAsync();

      expect(await outcome).toEqual(new Error('Run interrupted by Ctrl+C'));
      expect(rig.content_requests).toHaveBeenCalledOnce();
      expect(rig.request_signals[0]?.aborted).toBe(true);
    });

    it('hands a cancelled run to the caller rather than a file to record', async () => {
      const cancel = new AbortController();
      const rig = content_client_rig(stalled_request);
      const outcome = process_drive_backup_file(
        { keys: build_drive_storage_keys(binding.workload), fetch_chunks: vi.fn() },
        executor_connector(binding, rig.client),
        ITEM,
        'owner-1',
        {} as TenantContext,
        vi.fn(),
        cancel.signal,
      ).catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(1_000);
      cancel.abort(new Error('Run interrupted by Ctrl+C'));
      await vi.runAllTimersAsync();

      // Neither undefined (a failed file) nor a TransientDownloadError (a file listed for retry).
      expect(await outcome).toEqual(new Error('Run interrupted by Ctrl+C'));
    });
  },
);
