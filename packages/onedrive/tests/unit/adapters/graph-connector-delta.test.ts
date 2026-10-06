import { describe, expect, it } from 'vitest';
import { graph_error, stub_graph_client } from '@wisecom/atlas-types/testing/stub-graph-client';
import { GraphOneDriveConnector } from '@/adapters/graph-onedrive-connector.adapter';

const OWNER = 'aaaaaaaa-1111-2222-3333-444444444444';
const DRIVE = 'drive-1';
const ROOT_DELTA = `/users/${OWNER}/drives/${DRIVE}/root/delta`;
/** A cursor issued after the `package` facet joined the selection, so it is reused as-is. */
const CURRENT_CURSOR = `https://graph.microsoft.com/v1.0/drives/${DRIVE}/root/delta?$select=id,package&token=t1`;
const PAGE_2 = `https://graph.microsoft.com/v1.0/drives/${DRIVE}/root/delta?token=p2`;
const NEXT_CURSOR = `https://graph.microsoft.com/v1.0/drives/${DRIVE}/root/delta?$select=id,package&token=t2`;

/** What Graph answers a delta token it no longer honours: HTTP 410 with code and prose differing. */
const RESYNC_REQUIRED = graph_error(
  410,
  'resyncRequired',
  "Resync required. Replace any local items with the server's version (including deletes).",
);

function file(id: string, name: string): Record<string, unknown> {
  return { id, name, size: 10, file: {}, parentReference: { path: '/drive/root:' } };
}

function connector_over(route: Parameters<typeof stub_graph_client>[0]): {
  connector: GraphOneDriveConnector;
  calls: ReturnType<typeof stub_graph_client>['calls'];
} {
  const { client, calls } = stub_graph_client(route);
  return { connector: new GraphOneDriveConnector(client as never), calls };
}

describe('GraphOneDriveConnector.fetch_delta', () => {
  it('follows nextLink pages from the stored cursor and keeps the final deltaLink', async () => {
    const { connector, calls } = connector_over(({ url }) =>
      url === CURRENT_CURSOR
        ? { value: [file('a', 'a.txt'), { name: 'no id, skipped' }], '@odata.nextLink': PAGE_2 }
        : { value: [file('b', 'b.txt')], '@odata.deltaLink': NEXT_CURSOR },
    );

    const result = await connector.fetch_delta('tenant', OWNER, DRIVE, CURRENT_CURSOR);

    expect(calls.map((call) => call.url)).toEqual([CURRENT_CURSOR, PAGE_2]);
    expect(result.items.map((item) => item.item_id)).toEqual(['a', 'b']);
    expect(result.delta_link).toBe(NEXT_CURSOR);
    expect(result.reset_detected).toBe(false);
  });

  it('enumerates from the drive root with the field selection when there is no cursor', async () => {
    const { connector, calls } = connector_over(() => ({
      value: [],
      '@odata.deltaLink': NEXT_CURSOR,
    }));

    const result = await connector.fetch_delta('tenant', OWNER, DRIVE);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ROOT_DELTA);
    expect(calls[0]?.select).toContain('package');
    expect(result.reset_detected).toBe(false);
  });

  it('re-enumerates and reports a reset when Graph rejects the delta token', async () => {
    const { connector, calls } = connector_over(({ url }) => {
      if (url === CURRENT_CURSOR) throw RESYNC_REQUIRED;
      return { value: [file('a', 'a.txt')], '@odata.deltaLink': NEXT_CURSOR };
    });

    const result = await connector.fetch_delta('tenant', OWNER, DRIVE, CURRENT_CURSOR);

    expect(calls.map((call) => call.url)).toEqual([CURRENT_CURSOR, ROOT_DELTA]);
    expect(result.reset_detected).toBe(true);
    expect(result.items.map((item) => item.item_id)).toEqual(['a']);
    expect(result.delta_link).toBe(NEXT_CURSOR);
  });

  it('starts fresh and reports a reset for a cursor that predates the package facet', async () => {
    const stale = `https://graph.microsoft.com/v1.0/drives/${DRIVE}/root/delta?token=old`;
    const { connector, calls } = connector_over(() => ({
      value: [],
      '@odata.deltaLink': NEXT_CURSOR,
    }));

    const result = await connector.fetch_delta('tenant', OWNER, DRIVE, stale);

    expect(calls.map((call) => call.url)).toEqual([ROOT_DELTA]);
    expect(result.reset_detected).toBe(true);
  });

  it('reports a 403 as the missing permission, without re-enumerating', async () => {
    const { connector, calls } = connector_over(() => {
      throw graph_error(403, 'accessDenied', 'Access denied');
    });

    await expect(
      connector.fetch_delta('tenant', OWNER, DRIVE, CURRENT_CURSOR),
    ).rejects.toMatchObject({
      name: 'MissingGraphPermissionsError',
    });
    expect(calls).toHaveLength(1);
  });

  it('propagates an unrelated failure instead of treating it as a reset', async () => {
    const { connector, calls } = connector_over(() => {
      throw graph_error(400, 'invalidRequest', 'Invalid request');
    });

    await expect(
      connector.fetch_delta('tenant', OWNER, DRIVE, CURRENT_CURSOR),
    ).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(calls).toHaveLength(1);
  });
});
