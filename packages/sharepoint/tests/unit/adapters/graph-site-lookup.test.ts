import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@microsoft/microsoft-graph-client';
import { GraphAccessRefusedError, MissingGraphPermissionsError } from '@wisecom/atlas-types';
import { list_tenant_sites, resolve_site_reference } from '@/adapters/graph-sharepoint-site-lookup';

vi.mock('@wisecom/atlas-m365-graph', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, with_graph_retry: (fn: () => unknown) => fn() };
});

const CONTAINER_URL = 'https://contoso.sharepoint.com/contentstorage/CSP_container';
const DENIED = { statusCode: 403, code: 'accessDenied', message: 'Access denied' };

/** A client whose `get` answers by path prefix; an unmatched path fails the test. */
function client_answering(routes: Record<string, () => Promise<unknown>>): Client {
  const api = vi.fn((path: string) => {
    const route = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    if (route === undefined) throw new Error(`unexpected Graph path ${path}`);
    return { get: routes[route] };
  });
  return { api } as unknown as Client;
}

describe('list_tenant_sites', () => {
  it('flags SharePoint Embedded container sites by kind, across pages', async () => {
    const client = client_answering({
      '/sites?search=*': () =>
        Promise.resolve({
          value: [
            { id: 'contoso.sharepoint.com,a,b', webUrl: 'https://contoso.sharepoint.com/sites/x' },
            { webUrl: 'https://contoso.sharepoint.com/sites/no-id' },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next',
        }),
      'https://graph.microsoft.com/v1.0/next': () =>
        Promise.resolve({ value: [{ id: 'contoso.sharepoint.com,c,d', webUrl: CONTAINER_URL }] }),
    });

    const sites = await list_tenant_sites(client);

    expect(sites.map((site) => [site.site_id, site.kind])).toEqual([
      ['a,b', 'site'],
      ['c,d', 'file_storage_container'],
    ]);
  });

  it('types a 403 on the search as a missing Sites.Read.All grant', async () => {
    const client = client_answering({ '/sites?search=*': () => Promise.reject(DENIED) });

    const failure = await list_tenant_sites(client).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(MissingGraphPermissionsError);
    expect(failure).toMatchObject({
      code: 'ATLAS_AUTH_DENIED',
      permissions: ['Sites.Read.All'],
      status_code: 403,
      graph_code: 'accessDenied',
      cause: DENIED,
    });
    expect((failure as Error).message).toContain(
      "HTTP 403 accessDenied for the tenant's site search",
    );
  });

  it('passes any other search failure through unchanged', async () => {
    const outage = { statusCode: 503, code: 'serviceNotAvailable' };
    const client = client_answering({ '/sites?search=*': () => Promise.reject(outage) });

    await expect(list_tenant_sites(client)).rejects.toBe(outage);
  });
});

describe('resolve_site_reference', () => {
  it('names a container URL as a file_storage_container refusal when the grant works', async () => {
    const client = client_answering({
      '/sites/root': () => Promise.resolve({ id: 'root' }),
      '/sites/': () => Promise.reject(DENIED),
    });

    const failure = await resolve_site_reference(client, CONTAINER_URL).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(GraphAccessRefusedError);
    expect(failure).toMatchObject({
      code: 'ATLAS_ACCESS_REFUSED',
      reason: 'file_storage_container',
      site_id: undefined,
      status_code: 403,
      graph_code: 'accessDenied',
    });
  });

  it('names a refused site ID as access_refused, since its URL is unknown', async () => {
    const client = client_answering({
      '/sites/root': () => Promise.resolve({ id: 'root' }),
      '/sites/': () => Promise.reject(DENIED),
    });

    await expect(resolve_site_reference(client, 'host,site-guid,web-guid')).rejects.toMatchObject({
      reason: 'access_refused',
      site_id: 'host,site-guid,web-guid',
    });
  });

  it('reports a missing grant when the root site is refused as well', async () => {
    const client = client_answering({
      '/sites/root': () => Promise.reject(DENIED),
      '/sites/': () => Promise.reject(DENIED),
    });

    await expect(resolve_site_reference(client, 'host,site-guid,web-guid')).rejects.toBeInstanceOf(
      MissingGraphPermissionsError,
    );
  });

  it('returns an ordinary site with its kind', async () => {
    const client = client_answering({
      '/sites/': () =>
        Promise.resolve({ id: 'host,a,b', webUrl: 'https://contoso.sharepoint.com/sites/x' }),
    });

    await expect(resolve_site_reference(client, 'host,a,b')).resolves.toMatchObject({
      site_id: 'a,b',
      kind: 'site',
    });
  });
});
