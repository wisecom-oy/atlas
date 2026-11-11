import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, HTTPMessageHandler } from '@microsoft/microsoft-graph-client';
import type { OneDriveDeltaItem } from '@wisecom/atlas-types';
import { run_with_throttle_coordinator } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  binary_graph_response,
  queued_graph_fetch,
  throttled_graph_response,
} from '@wisecom/atlas-types/testing/queued-graph-fetch';
import {
  recording_throttle_coordinator,
  type RecordingThrottleCoordinator,
} from '@wisecom/atlas-types/testing/recording-throttle-coordinator';
import { ONEDRIVE_DOWNLOAD_EXECUTOR } from '@/adapters/graph-onedrive-download-executor';

/**
 * Issue #674 for the `/content` fallback of the shared download executor: `.getStream()` lost the
 * Retry-After of a 429 inside the Graph SDK, so the retry ran after about 1 s. A real Graph client
 * runs over a stubbed transport.
 */

const BYTES = Buffer.from('file-content-bytes');

let coordinator: RecordingThrottleCoordinator;
let client: Client;

/** An item with no download URL of its own, so the executor asks Graph for one. */
function make_item(): OneDriveDeltaItem {
  return {
    drive_id: 'drive-1',
    item_id: 'item-1',
    kind: 'file',
    file_name: 'file.bin',
    parent_path: '/',
    size_bytes: BYTES.length,
    deleted: false,
  };
}

/** Graph's answer to the download-URL lookup when it offers none, which routes to `/content`. */
function no_download_url_response(): Response {
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  vi.useFakeTimers();
  coordinator = recording_throttle_coordinator();
  client = Client.initWithMiddleware({ middleware: new HTTPMessageHandler() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('shared /content fallback Retry-After (issue #674)', () => {
  it('waits the 20 s Graph asked for and returns the file', async () => {
    const rig = queued_graph_fetch(
      no_download_url_response(),
      throttled_graph_response('20'),
      binary_graph_response(BYTES),
    );
    vi.stubGlobal('fetch', rig.fetch);

    const body = run_with_throttle_coordinator(coordinator, 'sharepoint_onedrive', () =>
      ONEDRIVE_DOWNLOAD_EXECUTOR.download_with_fallback(client, make_item()),
    );
    await vi.advanceTimersByTimeAsync(19_999);
    expect(rig.urls).toHaveLength(2);
    expect(coordinator.raises).toEqual([['sharepoint_onedrive', 20_000]]);
    await vi.advanceTimersByTimeAsync(2_001);

    expect(rig.urls).toHaveLength(3);
    expect(rig.urls[2]).toContain('/drives/drive-1/items/item-1/content');
    await expect(body).resolves.toEqual(BYTES);
  });
});
