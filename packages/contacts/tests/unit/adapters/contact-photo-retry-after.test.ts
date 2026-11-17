import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, HTTPMessageHandler } from '@microsoft/microsoft-graph-client';
import { run_with_throttle_coordinator } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  binary_graph_response,
  graph_error_response,
  queued_graph_fetch,
  throttled_graph_response,
} from '@wisecom/atlas-types/testing/queued-graph-fetch';
import {
  recording_throttle_coordinator,
  type RecordingThrottleCoordinator,
} from '@wisecom/atlas-types/testing/recording-throttle-coordinator';
import { fetch_contact_photo } from '@/adapters/graph-contacts-items';

/**
 * Issue #674: a 429 on `/photo/$value` lost its Retry-After inside the Graph SDK, so the retry ran
 * after about 1 s and the pool cooled down for the 30 s default. A real Graph client runs over a
 * stubbed transport.
 */

const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

let coordinator: RecordingThrottleCoordinator;
let client: Client;

beforeEach(() => {
  vi.useFakeTimers();
  coordinator = recording_throttle_coordinator();
  client = Client.initWithMiddleware({ middleware: new HTTPMessageHandler() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetch_contact_photo Retry-After (issue #674)', () => {
  it('waits the 20 s Graph asked for and returns the photo bytes', async () => {
    const rig = queued_graph_fetch(throttled_graph_response('20'), binary_graph_response(PHOTO));
    vi.stubGlobal('fetch', rig.fetch);

    const photo = run_with_throttle_coordinator(coordinator, 'outlook', () =>
      fetch_contact_photo(client, 'mailbox-1', 'folder-1', 'contact-1'),
    );
    await vi.advanceTimersByTimeAsync(19_999);
    expect(rig.urls).toHaveLength(1);
    expect(coordinator.raises).toEqual([['outlook', 20_000]]);
    await vi.advanceTimersByTimeAsync(2_001);

    expect(rig.urls).toHaveLength(2);
    expect([...((await photo) ?? [])]).toEqual([...PHOTO]);
  });

  it('still reads a 404 as a contact without a photo', async () => {
    vi.stubGlobal(
      'fetch',
      queued_graph_fetch(graph_error_response(404, 'ErrorItemNotFound')).fetch,
    );

    await expect(
      fetch_contact_photo(client, 'mailbox-1', 'folder-1', 'contact-1'),
    ).resolves.toBeUndefined();
  });
});
