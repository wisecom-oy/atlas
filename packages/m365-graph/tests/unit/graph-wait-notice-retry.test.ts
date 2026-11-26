/**
 * Issue #880. A long wait inside the retry loop printed nothing at the default log level, so a run
 * backing off through an outage looked the same as a hung one. A wait over a minute now prints one
 * warn line when it starts; the per-retry debug line is unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { GraphUnavailableError } from '@wisecom/atlas-types';
import { with_graph_retry } from '@/graph-request-error-handler';
import { GraphTokenRequestError } from '@/graph-token-failure';
import { LONG_WAIT_NOTICE_MS } from '@/graph-wait-notice';

const END = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z';

let warn: ReturnType<typeof vi.spyOn>;
let debug: ReturnType<typeof vi.spyOn>;

function failure(status: number, retry_after?: string): Record<string, unknown> {
  const headers = new Headers(retry_after === undefined ? {} : { 'retry-after': retry_after });
  return { statusCode: status, message: 'Service Unavailable', headers };
}

function token_failure(retry_after_ms: number): GraphTokenRequestError {
  return new GraphTokenRequestError('Microsoft Entra ID did not issue a Graph token', {
    cause: undefined,
    entra_status: 503,
    transient: true,
    retry_after_ms,
  });
}

/** Every warn line that announces a wait. */
function wait_lines(): string[] {
  return warn.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith('Waiting'));
}

/** Runs `fn` through the retry loop with no coordinator, until it settles. */
async function settle(fn: () => Promise<unknown>): Promise<unknown> {
  const call = with_graph_retry(fn).catch((err: unknown) => err);
  await vi.advanceTimersByTimeAsync(2 * 3_600_000);
  return call;
}

beforeEach(() => {
  vi.useFakeTimers();
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('with_graph_retry long wait notice (issue #880)', () => {
  it('announces each backoff over a minute once, naming the retry, the cause and the end', async () => {
    const result = await settle(() => Promise.reject(failure(503)));

    expect(result).toBeInstanceOf(GraphUnavailableError);
    // 1 + 2 + ... + 32 s stay under the threshold; 64, 128, 256 and three 300 s waits pass it.
    const lines = wait_lines();
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(
      new RegExp(`^Waiting \\d+ s, until ${END}, for backoff before retry 7 of 12 after HTTP 503$`),
    );
    expect(lines[5]).toMatch(/^Waiting 5 min, until .*, for backoff before retry 12 of 12 after/);
  });

  it('keeps the per-retry debug line as it was', async () => {
    await settle(() => Promise.reject(failure(503)));

    expect(debug).toHaveBeenCalledTimes(12);
    expect(debug.mock.calls[0]![0]).toMatch(/^Retry 1\/12 in \d+\.\ds -- HTTP 503$/);
  });

  it('announces a Retry-After wait over a minute that raises no cooldown', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure(503, '120'))
      .mockResolvedValueOnce('ok');

    await settle(fn);

    expect(wait_lines()).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Waiting 2 min, until ${END}, for the Retry-After Microsoft Graph asked for ` +
            `before retry 1 of 12 after HTTP 503$`,
        ),
      ),
    ]);
  });

  it('prints nothing for a wait of a minute or less', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure(503, String(LONG_WAIT_NOTICE_MS / 1000)))
      .mockRejectedValueOnce(failure(429))
      .mockResolvedValueOnce('ok');

    await settle(fn);

    expect(fn).toHaveBeenCalledTimes(3);
    expect(wait_lines()).toEqual([]);
  });

  it('keeps the 60 s hold after a failed token request silent, and names a longer one', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(token_failure(60_000))
      .mockRejectedValueOnce(token_failure(180_000))
      .mockResolvedValueOnce('ok');

    await settle(fn);

    expect(wait_lines()).toEqual([
      expect.stringMatching(
        /^Waiting 3 min, until .*, for the hold on token requests after a failed one before retry 2 of 12 after a failed token request \(HTTP 503\)$/,
      ),
    ]);
  });
});
