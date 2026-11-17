import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { Client, HTTPMessageHandler } from '@microsoft/microsoft-graph-client';
import { GRAPH_CLIENT_TOKEN } from '@wisecom/atlas-m365-graph';
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
import { GraphOneDriveConnector } from '@/adapters/graph-onedrive-connector.adapter';

/**
 * Issue #674: a 429 on a version's `/content` lost its Retry-After inside the Graph SDK, so the
 * retry ran after about 1 s and the pool cooled down for the 30 s default. A real Graph client runs
 * over a stubbed transport.
 */

const BYTES = Buffer.from('version-bytes');

let coordinator: RecordingThrottleCoordinator;
let connector: GraphOneDriveConnector;

async function drain(stream: AsyncIterable<Buffer | Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

beforeEach(() => {
  vi.useFakeTimers();
  coordinator = recording_throttle_coordinator();
  const container = new Container();
  container
    .bind(GRAPH_CLIENT_TOKEN)
    .toConstantValue(Client.initWithMiddleware({ middleware: new HTTPMessageHandler() }));
  container.bind(GraphOneDriveConnector).toSelf();
  connector = container.get(GraphOneDriveConnector);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GraphOneDriveConnector version content Retry-After (issue #674)', () => {
  it('waits the 20 s Graph asked for and streams the version bytes', async () => {
    const rig = queued_graph_fetch(throttled_graph_response('20'), binary_graph_response(BYTES));
    vi.stubGlobal('fetch', rig.fetch);

    const stream = run_with_throttle_coordinator(coordinator, 'sharepoint_onedrive', () =>
      connector.stream_file_version('drive-1', 'item-1', '3.0'),
    );
    await vi.advanceTimersByTimeAsync(19_999);
    expect(rig.urls).toHaveLength(1);
    expect(coordinator.raises).toEqual([['sharepoint_onedrive', 20_000]]);
    await vi.advanceTimersByTimeAsync(2_001);

    expect(rig.urls).toHaveLength(2);
    expect(rig.urls[1]).toContain('/drives/drive-1/items/item-1/versions/3.0/content');
    expect(await drain(await stream)).toEqual(BYTES);
  });
});
