import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@microsoft/microsoft-graph-client';
import { GraphUnavailableError } from '@wisecom/atlas-types';
import {
  ATTEMPTS_PER_RETRY_CHAIN,
  GraphOutageFault,
  RETRY_BUDGET_SPAN_MS,
} from '@wisecom/atlas-types/testing/graph-outage-fault';
import { fetch_message_extended_properties } from '@/adapters/graph-message-extended-property-fetcher';

/**
 * Issue #881. Reactions are read 20 messages per `$batch`. A chunk whose retry budget ran out was
 * logged and the next chunk started a fresh budget against the same outage. The outage now throws
 * after the first chunk's budget.
 */

function message_ids(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `msg-${i}`);
}

describe('fetch_message_extended_properties under a Graph outage', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('throws after one chunk spent its budget instead of starting the next chunk', async () => {
    const graph = new GraphOutageFault();
    const request = { post: graph.send, option: () => request };
    const client = { api: vi.fn(() => request) } as unknown as Client;

    const fetching = fetch_message_extended_properties(client, 'owner-1', message_ids(45), 'p');
    const outcome = fetching.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET_SPAN_MS);

    expect(await outcome).toBeInstanceOf(GraphUnavailableError);
    expect(graph.requests).toBe(ATTEMPTS_PER_RETRY_CHAIN);
  });
});
