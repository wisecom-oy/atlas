import { describe, it, expect, vi, type Mock } from 'vitest';
import type { Client } from '@microsoft/microsoft-graph-client';
import {
  AuthError,
  GraphAccessRefusedError,
  MissingGraphPermissionsError,
} from '@wisecom/atlas-types';
import { SHAREPOINT_DOWNLOAD_EXECUTOR } from '@/adapters/graph-sharepoint-download-executor';

// The retry wrapper runs the call once, so call counts are attempts.
vi.mock('@wisecom/atlas-m365-graph', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, with_graph_retry: (fn: () => unknown) => fn() };
});

/**
 * Issue #772: Graph answers a SharePoint Embedded container site and a missing grant with the same
 * 403 `accessDenied`, so one `GET /sites/root` tells them apart.
 */
describe('SharePoint enumeration 403 classification', () => {
  const { rethrow_if_access_denied } = SHAREPOINT_DOWNLOAD_EXECUTOR;
  const SITE = { label: 'site site-1', site_id: 'site-1' };
  const denied = { statusCode: 403, code: 'accessDenied', message: 'Access denied' };

  function root_check_client(root: () => Promise<unknown>): { client: Client; api: Mock } {
    const api = vi.fn(() => ({ get: root }));
    return { client: { api } as unknown as Client, api };
  }

  it('reports a refused site when the root site is readable, keeping the Graph error', async () => {
    const { client, api } = root_check_client(() => Promise.resolve({ id: 'root' }));

    const failure = await rethrow_if_access_denied(client, denied, SITE).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(GraphAccessRefusedError);
    expect(failure).not.toBeInstanceOf(AuthError);
    expect(failure).toMatchObject({
      code: 'ATLAS_ACCESS_REFUSED',
      reason: 'access_refused',
      site_id: 'site-1',
      status_code: 403,
      graph_code: 'accessDenied',
      cause: denied,
    });
    expect((failure as Error).message).toContain('HTTP 403 accessDenied');
    expect((failure as Error).message).not.toContain('needs the');
    // A readable root site rules out a tenant-wide gap only; a per-site grant may still be missing.
    expect((failure as Error).message).not.toContain('is granted');
    expect((failure as Error).message).toContain('it needs a Sites.Selected grant on this site');
    expect(api).toHaveBeenCalledWith('/sites/root?$select=id');
  });

  it('reports a container site by reason when the caller knows its URL shape', async () => {
    const { client } = root_check_client(() => Promise.resolve({ id: 'root' }));
    const container = { ...SITE, is_file_storage_container: true };

    await expect(rethrow_if_access_denied(client, denied, container)).rejects.toMatchObject({
      reason: 'file_storage_container',
      message: expect.stringContaining('FileStorageContainer.Selected'),
    });
  });

  it('reports a missing grant naming Sites.Read.All or Sites.Selected when root is refused too', async () => {
    const { client } = root_check_client(() => Promise.reject(denied));

    const failure = await rethrow_if_access_denied(client, denied, SITE).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(MissingGraphPermissionsError);
    expect(failure).toBeInstanceOf(AuthError);
    expect(failure).toMatchObject({
      code: 'ATLAS_AUTH_DENIED',
      permissions: ['Sites.Read.All'],
      status_code: 403,
      graph_code: 'accessDenied',
      cause: denied,
    });
    expect((failure as Error).message).toContain('HTTP 403 accessDenied');
    expect((failure as Error).message).toContain('Sites.Read.All');
    expect((failure as Error).message).toContain('a Sites.Selected grant on this site');
  });

  it('checks the root site once per client, however many sites are refused', async () => {
    const { client, api } = root_check_client(() => Promise.resolve({ id: 'root' }));

    await rethrow_if_access_denied(client, denied, SITE).catch(() => undefined);
    await rethrow_if_access_denied(client, denied, {
      label: 'site site-2',
      site_id: 'site-2',
    }).catch(() => undefined);

    expect(api).toHaveBeenCalledOnce();
  });

  it('asks again after a root check that failed for another reason', async () => {
    const outage = { statusCode: 503 };
    const root = vi.fn().mockRejectedValueOnce(outage).mockResolvedValue({ id: 'root' });
    const { client } = root_check_client(root);

    await expect(rethrow_if_access_denied(client, denied, SITE)).rejects.toBe(outage);
    await expect(rethrow_if_access_denied(client, denied, SITE)).rejects.toBeInstanceOf(
      GraphAccessRefusedError,
    );
    expect(root).toHaveBeenCalledTimes(2);
  });

  it('reports a 403 whose code is not a missing grant as refused, without a root check', async () => {
    const { client, api } = root_check_client(() => Promise.resolve({ id: 'root' }));

    await expect(
      rethrow_if_access_denied(client, { statusCode: 403, code: 'notAllowed' }, SITE),
    ).rejects.toMatchObject({ code: 'ATLAS_ACCESS_REFUSED', graph_code: 'notAllowed' });
    expect(api).not.toHaveBeenCalled();
  });
});
