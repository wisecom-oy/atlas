import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphUnavailableError } from '@wisecom/atlas-types';
import { stub_graph_client, type GraphCall } from '@wisecom/atlas-types/testing/stub-graph-client';
import {
  ATTEMPTS_PER_RETRY_CHAIN,
  RETRY_BUDGET_SPAN_MS,
} from '@wisecom/atlas-types/testing/graph-outage-fault';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { batch_read_each, type BatchReadRequest } from '@/graph/graph-batch-read';

/**
 * Issue #881: a `$batch` chunk that spent its retry budget is a Graph outage. It propagates, so the
 * drive fails and keeps its delta link, instead of being logged while every later chunk spends a
 * budget of its own and the drive's items are stored without their metadata.
 */

interface SubRequest {
  readonly id: string;
}

const SPEC = { label: 'Permission capture', read_body: (body: Record<string, unknown>) => body };

function requests(count: number): BatchReadRequest[] {
  return Array.from({ length: count }, (_, i) => ({ key: `item-${i}`, url: `/items/item-${i}` }));
}

describe('batch_read_each under a Graph outage (#881)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rethrows the exhausted budget and sends no later chunk', async () => {
    const stub = stub_graph_client(() => {
      throw Object.assign(new Error('Service Unavailable'), { statusCode: 503 });
    });

    const read = batch_read_each(stub.client, requests(45), SPEC).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET_SPAN_MS);

    expect(await read).toBeInstanceOf(GraphUnavailableError);
    expect(stub.calls).toHaveLength(ATTEMPTS_PER_RETRY_CHAIN);
  });

  it('still logs and skips the items Graph refused for good', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const stub = stub_graph_client((call: GraphCall) => {
      const subs = (call.body as { requests: SubRequest[] }).requests;
      return {
        responses: subs.map((sub) =>
          sub.id === '1'
            ? { id: sub.id, status: 404, body: { error: { code: 'itemNotFound' } } }
            : sub.id === '2'
              ? { id: sub.id, status: 403, body: { error: { code: 'accessDenied' } } }
              : { id: sub.id, status: 200, body: { value: [] } },
        ),
      };
    });

    const found = await batch_read_each(stub.client, requests(3), SPEC);

    expect([...found.keys()]).toEqual(['item-0']);
    expect(stub.calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped 2 item(s) Graph refused'));
  });
});
