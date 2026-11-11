import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  cancellable_sleep,
  parse_retry_after_ms,
  report_transfer_throttle,
  wait_for_transfer_slot,
} from '@wisecom/atlas-m365-graph';
import { CdnHttpError } from '@/backup/cdn-chunk-errors';
import { compute_chunk_timeout_ms } from '@/backup/cdn-chunk-request';
import { assert_transferred_size } from '@/backup/download-integrity';

/** Retries of a 429 from the download URL before the failure is handed to the caller. */
export const MAX_URL_RETRIES = 3;

const URL_RETRY_BASE_DELAY_MS = 1_000;

/** What one request to the download URL produced: the body, or a 429 to wait out. */
type UrlAttemptOutcome =
  | { readonly kind: 'body'; readonly body: Buffer }
  | { readonly kind: 'throttled'; readonly retry_after_ms: number | undefined };

/**
 * Downloads a pre-authenticated URL into one buffer, retrying a 429 up to MAX_URL_RETRIES times.
 *
 * A non-2xx answer throws `CdnHttpError` with its status, so the caller can tell a stale URL
 * (401, 403) from anything else and re-resolve it. The OneDrive copy this replaced threw a plain
 * `Error`, so a stale URL went to `/content` and a 429 was never retried (issue #675).
 *
 * The 429 wait honours `Retry-After` through the shared parser (an HTTP date is understood, a huge
 * value is clamped to an hour) and ends at once when the run is cancelled (issue #628).
 */
export async function download_from_url(
  label: string,
  download_url: string,
  size_bytes: number,
  item_id: string,
  abort_signal?: AbortSignal,
): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    const outcome = await attempt_url_download(
      label,
      download_url,
      size_bytes,
      item_id,
      abort_signal,
    );
    if (outcome.kind === 'body') return outcome.body;

    if (attempt === MAX_URL_RETRIES) {
      throw new CdnHttpError(
        `HTTP 429 downloading ${label} file ${item_id}`,
        429,
        outcome.retry_after_ms,
      );
    }
    const delay = outcome.retry_after_ms ?? URL_RETRY_BASE_DELAY_MS * 2 ** attempt;
    logger.debug(`HTTP 429 downloading ${label} file ${item_id}, retry in ${delay}ms`);
    await cancellable_sleep(delay, abort_signal);
  }
}

/**
 * One request under a timeout scaled to the size, ended early when the run is cancelled.
 *
 * The transfer slot is awaited before the timer is armed, so a throttle cooldown is not timed as
 * the request. The byte count is checked against the recorded size, so a well-framed 200 with the
 * wrong body is never stored under a checksum of those wrong bytes (issue #368).
 */
async function attempt_url_download(
  label: string,
  download_url: string,
  size_bytes: number,
  item_id: string,
  abort_signal: AbortSignal | undefined,
): Promise<UrlAttemptOutcome> {
  await wait_for_transfer_slot(abort_signal);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), compute_chunk_timeout_ms(size_bytes));
  const cancel_request = (): void => controller.abort(abort_signal?.reason);
  abort_signal?.addEventListener('abort', cancel_request, { once: true });
  try {
    const response = await fetch(download_url, { signal: controller.signal });
    report_transfer_throttle(response);
    if (response.status === 429) {
      const retry_after_ms = parse_retry_after_ms(response.headers.get('Retry-After'));
      return { kind: 'throttled', retry_after_ms };
    }
    if (!response.ok) {
      throw new CdnHttpError(
        `Failed to download ${label} file ${item_id}: HTTP ${response.status}`,
        response.status,
      );
    }
    const body = Buffer.from(await response.arrayBuffer());
    assert_transferred_size(item_id, body.length, size_bytes);
    return { kind: 'body', body };
  } finally {
    clearTimeout(timer);
    abort_signal?.removeEventListener('abort', cancel_request);
  }
}
