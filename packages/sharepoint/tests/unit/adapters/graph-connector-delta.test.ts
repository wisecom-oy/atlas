import { describe, expect, it } from 'vitest';
import { graph_error, stub_graph_client } from '@wisecom/atlas-types/testing/stub-graph-client';
import { GraphSharePointConnector } from '@/adapters/graph-sharepoint-connector.adapter';

const SITE = 'contoso.sharepoint.com,site-guid,web-guid';
const DRIVE = 'drive-1';
const ROOT_DELTA = `/drives/${DRIVE}/root/delta`;
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
  return { id, name, size: 10, file: {}, parentReference: { path: `/drives/${DRIVE}/root:` } };
}

function connector_over(route: Parameters<typeof stub_graph_client>[0]): {
  connector: GraphSharePointConnector;
  calls: ReturnType<typeof stub_graph_client>['calls'];
} {
  const { client, calls } = stub_graph_client(route);
  return { connector: new GraphSharePointConnector(client as never), calls };
}

describe('GraphSharePointConnector.fetch_delta', () => {
  it('follows nextLink pages from the stored cursor and keeps the final deltaLink', async () => {
    const { connector, calls } = connector_over(({ url }) =>
      url === CURRENT_CURSOR
        ? { value: [file('a', 'a.txt'), { name: 'no id, skipped' }], '@odata.nextLink': PAGE_2 }
        : { value: [file('b', 'b.txt')], '@odata.deltaLink': NEXT_CURSOR },
    );

    const result = await connector.fetch_delta('tenant', SITE, DRIVE, CURRENT_CURSOR);

    expect(calls.map((call) => call.url)).toEqual([CURRENT_CURSOR, PAGE_2]);
    expect(result.items.map((item) => item.item_id)).toEqual(['a', 'b']);
    expect(result.delta_link).toBe(NEXT_CURSOR);
    expect(result.reset_detected).toBe(false);
  });

  it('enumerates from the library root with the field selection when there is no cursor', async () => {
    const { connector, calls } = connector_over(() => ({
      value: [],
      '@odata.deltaLink': NEXT_CURSOR,
    }));

    const result = await connector.fetch_delta('tenant', SITE, DRIVE);

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

    const result = await connector.fetch_delta('tenant', SITE, DRIVE, CURRENT_CURSOR);

    expect(calls.map((call) => call.url)).toEqual([CURRENT_CURSOR, ROOT_DELTA]);
    expect(result.reset_detected).toBe(true);
    expect(result.items.map((item) => item.item_id)).toEqual(['a']);
  });

  it('starts fresh and reports a reset for a cursor that predates the package facet', async () => {
    const stale = `https://graph.microsoft.com/v1.0/drives/${DRIVE}/root/delta?token=old`;
    const { connector, calls } = connector_over(() => ({
      value: [],
      '@odata.deltaLink': NEXT_CURSOR,
    }));

    const result = await connector.fetch_delta('tenant', SITE, DRIVE, stale);

    expect(calls.map((call) => call.url)).toEqual([ROOT_DELTA]);
    expect(result.reset_detected).toBe(true);
  });

  it('reports a 403 as the missing permission, without re-enumerating', async () => {
    const { connector, calls } = connector_over(() => {
      throw graph_error(403, 'accessDenied', 'Access denied');
    });

    await expect(
      connector.fetch_delta('tenant', SITE, DRIVE, CURRENT_CURSOR),
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
      connector.fetch_delta('tenant', SITE, DRIVE, CURRENT_CURSOR),
    ).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(calls).toHaveLength(1);
  });
});

describe('GraphSharePointConnector.resolve_site', () => {
  it('resolves a site URL through the hostname:/path reference Graph expects', async () => {
    const { connector, calls } = connector_over(() => ({
      id: SITE,
      webUrl: 'https://contoso.sharepoint.com/sites/Example',
      displayName: 'Example',
    }));

    const site = await connector.resolve_site(
      'tenant',
      'https://contoso.sharepoint.com/sites/Example',
    );

    expect(calls[0]?.url).toBe(
      '/sites/contoso.sharepoint.com:/sites/Example?$select=id,webUrl,displayName',
    );
    expect(site).toEqual({
      site_id: SITE,
      site_url: 'https://contoso.sharepoint.com/sites/Example',
      display_name: 'Example',
    });
  });

  it('fails rather than returning a site without an id', async () => {
    const { connector } = connector_over(() => ({ webUrl: 'https://contoso.sharepoint.com' }));

    await expect(connector.resolve_site('tenant', 'contoso.sharepoint.com')).rejects.toThrow(
      'Failed to resolve SharePoint site: contoso.sharepoint.com',
    );
  });
});
