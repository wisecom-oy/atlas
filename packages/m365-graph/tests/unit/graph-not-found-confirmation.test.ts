/**
 * The in-run confirmation rule for a run's first read (issues #862, #863 and #864).
 *
 * `with_graph_retry` never repeats a 4xx, so one 404 on a mailbox existence check or a first
 * listing ended the run with exit `7`. The rule reads a doubtful 4xx again, twice, and passes a 404
 * that persisted back to the caller. Every other 4xx that persisted is classified as
 * `GraphUnavailableError`, and the answers another layer owns are never repeated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphUnavailableError } from '@wisecom/atlas-types';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  NOT_FOUND_REREAD_DELAYS_MS,
  read_confirming_not_found,
} from '@/graph-not-found-confirmation';

/** A read that fails with each of `failures` in turn, then answers `ok`. */
function read_failing(...failures: Error[]) {
  const read = vi.fn(async () => {
    const failure = failures[read.mock.calls.length - 1];
    if (failure) throw failure;
    return 'ok';
  });
  return read;
}

/** Runs the rule to completion, advancing fake time through every wait. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const outcome = await settled;
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('read_confirming_not_found', () => {
  it('returns the answer of a read that succeeds after one 404', async () => {
    const read = read_failing(graph_error(404, 'ErrorItemNotFound'));

    await expect(settle(read_confirming_not_found(read))).resolves.toBe('ok');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('passes a 404 back unchanged after three reads, about 6 s apart in all', async () => {
    const not_found = graph_error(404, 'Request_ResourceNotFound');
    const read = read_failing(not_found, not_found, not_found);
    const started = Date.now();

    await expect(settle(read_confirming_not_found(read))).rejects.toBe(not_found);
    expect(read).toHaveBeenCalledTimes(1 + NOT_FOUND_REREAD_DELAYS_MS.length);
    expect(Date.now() - started).toBe(6_000);
  });

  it('classifies a 400 that persists as GraphUnavailableError, keeping status and code', async () => {
    const bad = graph_error(400, 'invalidRequest');
    const read = read_failing(bad, bad, bad);

    const err = await settle(read_confirming_not_found(read)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphUnavailableError);
    expect(err).toMatchObject({
      code: 'ATLAS_GRAPH_UNAVAILABLE',
      status_code: 400,
      graph_code: 'invalidRequest',
      retries: 2,
      cause: bad,
    });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('returns once a 400 clears', async () => {
    const read = read_failing(graph_error(400, 'invalidRequest'));

    await expect(settle(read_confirming_not_found(read))).resolves.toBe('ok');
  });

  it.each([
    [401, 'InvalidAuthenticationToken'],
    [403, 'ErrorAccessDenied'],
    [429, 'TooManyRequests'],
  ])('never repeats a %i, which another layer classifies', async (status, code) => {
    const refusal = graph_error(status, code);
    const read = read_failing(refusal);

    await expect(settle(read_confirming_not_found(read))).rejects.toBe(refusal);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('never repeats MailboxNotEnabledForRESTAPI, whatever its status', async () => {
    const unlicensed = graph_error(404, 'MailboxNotEnabledForRESTAPI');
    const read = read_failing(unlicensed);

    await expect(settle(read_confirming_not_found(read))).rejects.toBe(unlicensed);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('never repeats an answer the caller marks conclusive', async () => {
    const no_drive = graph_error(404, 'ResourceNotFound', "User's mysite not found.");
    const read = read_failing(no_drive);

    const outcome = read_confirming_not_found(read, (err) => err === no_drive);

    await expect(settle(outcome)).rejects.toBe(no_drive);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('never repeats a failure that carries no HTTP status', async () => {
    const outage = new GraphUnavailableError('down', { retries: 12, elapsed_ms: 1 });
    const read = read_failing(outage);

    await expect(settle(read_confirming_not_found(read))).rejects.toBe(outage);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('stops waiting as soon as the run is cancelled', async () => {
    const controller = new AbortController();
    const read = read_failing(graph_error(404, 'itemNotFound'));

    const outcome = run_with_abort_signal(controller.signal, () =>
      read_confirming_not_found(read),
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort(new Error('cancelled'));

    await expect(outcome).resolves.toMatchObject({ message: 'cancelled' });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
