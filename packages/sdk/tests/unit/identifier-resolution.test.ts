import { describe, expect, it, vi } from 'vitest';
import type { Container } from 'inversify';
import type { Mock } from 'vitest';
import {
  ONEDRIVE_BACKUP_USE_CASE_TOKEN,
  ONEDRIVE_CATALOG_USE_CASE_TOKEN,
  ONEDRIVE_DELETION_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN,
  STATS_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { create_onedrive_api } from '@/onedrive-api.factory';
import { create_sharepoint_api } from '@/sharepoint-api.factory';

const TENANT_ID = 'tenant-1';
const OBJECT_ID = '00000000-0000-0000-0000-000000000000';
const EMAIL = 'john.doe@example.com';
const SITE_URL = 'https://contoso.sharepoint.com/sites/Example';
const SITE_ID = `contoso.sharepoint.com,${OBJECT_ID},11111111-1111-1111-1111-111111111111`;

function container_with(...entries: [symbol, unknown][]): Container {
  const services = new Map(entries);
  return {
    get: vi.fn((requested: symbol) => services.get(requested) ?? {}),
  } as unknown as Container;
}

function identity_resolver(): { resolve_user: Mock } {
  return {
    resolve_user: vi.fn().mockResolvedValue({
      object_id: OBJECT_ID,
      email: EMAIL,
      display_name: 'John Doe',
    }),
  };
}

describe('OneDrive owner resolution (issue #181)', () => {
  it('resolves an email to an object id before calling the use case', async () => {
    const backup_onedrive = vi.fn().mockResolvedValue({});
    const resolver = identity_resolver();
    const api = create_onedrive_api(
      TENANT_ID,
      container_with(
        [ONEDRIVE_BACKUP_USE_CASE_TOKEN, { backup_onedrive }],
        [USER_IDENTITY_RESOLVER_TOKEN, resolver],
      ),
    );

    await api.backup(EMAIL);

    expect(resolver.resolve_user).toHaveBeenCalledWith(TENANT_ID, EMAIL);
    expect(backup_onedrive.mock.calls[0]![1]).toBe(OBJECT_ID);
  });

  it('forwards the resolved identity so the registry learns the email', async () => {
    const backup_onedrive = vi.fn().mockResolvedValue({});
    const api = create_onedrive_api(
      TENANT_ID,
      container_with(
        [ONEDRIVE_BACKUP_USE_CASE_TOKEN, { backup_onedrive }],
        [USER_IDENTITY_RESOLVER_TOKEN, identity_resolver()],
      ),
    );

    await api.backup(EMAIL);

    expect(backup_onedrive.mock.calls[0]![2]).toMatchObject({
      owner_email: EMAIL,
      owner_display_name: 'John Doe',
    });
  });

  it('leaves an object id untouched and never calls the resolver', async () => {
    const list_onedrive_snapshots = vi.fn().mockResolvedValue([]);
    const resolver = identity_resolver();
    const api = create_onedrive_api(
      TENANT_ID,
      container_with(
        [ONEDRIVE_CATALOG_USE_CASE_TOKEN, { list_onedrive_snapshots }],
        [USER_IDENTITY_RESOLVER_TOKEN, resolver],
      ),
    );

    await api.listSnapshots(OBJECT_ID);

    expect(resolver.resolve_user).not.toHaveBeenCalled();
    expect(list_onedrive_snapshots).toHaveBeenCalledWith(TENANT_ID, OBJECT_ID);
  });

  it('resolves on destructive calls too, so a delete cannot target the wrong scope', async () => {
    const delete_owner_data = vi.fn().mockResolvedValue({});
    const api = create_onedrive_api(
      TENANT_ID,
      container_with(
        [ONEDRIVE_DELETION_USE_CASE_TOKEN, { delete_owner_data }],
        [USER_IDENTITY_RESOLVER_TOKEN, identity_resolver()],
      ),
    );

    await api.deleteOwnerData(EMAIL);

    expect(delete_owner_data).toHaveBeenCalledWith(TENANT_ID, OBJECT_ID);
  });

  it('propagates a resolution failure instead of addressing a missing owner', async () => {
    const backup_onedrive = vi.fn().mockResolvedValue({});
    const resolver = { resolve_user: vi.fn().mockRejectedValue(new Error('user not found')) };
    const api = create_onedrive_api(
      TENANT_ID,
      container_with(
        [ONEDRIVE_BACKUP_USE_CASE_TOKEN, { backup_onedrive }],
        [USER_IDENTITY_RESOLVER_TOKEN, resolver],
      ),
    );

    await expect(api.backup(EMAIL)).rejects.toThrow('user not found');
    expect(backup_onedrive).not.toHaveBeenCalled();
  });

  it('resolves the owner on getStats and stays tenant-wide when it is omitted', async () => {
    const get_onedrive_stats = vi.fn().mockResolvedValue({});
    const resolver = identity_resolver();
    const api = create_onedrive_api(
      TENANT_ID,
      container_with(
        [STATS_USE_CASE_TOKEN, { get_onedrive_stats }],
        [USER_IDENTITY_RESOLVER_TOKEN, resolver],
      ),
    );

    await api.getStats(EMAIL);
    await api.getStats();

    expect(resolver.resolve_user).toHaveBeenCalledTimes(1);
    expect(get_onedrive_stats).toHaveBeenNthCalledWith(1, TENANT_ID, OBJECT_ID);
    expect(get_onedrive_stats).toHaveBeenNthCalledWith(2, TENANT_ID, undefined);
  });
});

describe('SharePoint site resolution (issue #181)', () => {
  it('resolves a site URL to a composite id before calling the use case', async () => {
    const backup_site_tree = vi.fn().mockResolvedValue([]);
    const resolve_site = vi.fn().mockResolvedValue({
      site_id: SITE_ID,
      site_url: SITE_URL,
      display_name: 'Example',
    });
    const api = create_sharepoint_api(
      TENANT_ID,
      container_with(
        [SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN, { backup_site_tree }],
        [SHAREPOINT_CONNECTOR_TOKEN, { resolve_site }],
      ),
    );

    await api.backup(SITE_URL);

    expect(resolve_site).toHaveBeenCalledWith(TENANT_ID, SITE_URL);
    expect(backup_site_tree.mock.calls[0]![1]).toBe(SITE_ID);
  });

  it('passes a composite id straight through', async () => {
    const backup_site_tree = vi.fn().mockResolvedValue([]);
    const resolve_site = vi.fn();
    const api = create_sharepoint_api(
      TENANT_ID,
      container_with(
        [SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN, { backup_site_tree }],
        [SHAREPOINT_CONNECTOR_TOKEN, { resolve_site }],
      ),
    );

    await api.backup(SITE_ID);

    expect(resolve_site).not.toHaveBeenCalled();
    expect(backup_site_tree.mock.calls[0]![1]).toBe(SITE_ID);
  });

  it('resolves the site on getStats and stays tenant-wide when it is omitted', async () => {
    const get_sharepoint_stats = vi.fn().mockResolvedValue({});
    const resolve_site = vi.fn().mockResolvedValue({
      site_id: SITE_ID,
      site_url: SITE_URL,
      display_name: 'Example',
    });
    const api = create_sharepoint_api(
      TENANT_ID,
      container_with(
        [STATS_USE_CASE_TOKEN, { get_sharepoint_stats }],
        [SHAREPOINT_CONNECTOR_TOKEN, { resolve_site }],
      ),
    );

    await api.getStats(SITE_URL);
    await api.getStats();

    expect(resolve_site).toHaveBeenCalledTimes(1);
    expect(get_sharepoint_stats).toHaveBeenNthCalledWith(1, TENANT_ID, SITE_ID);
    expect(get_sharepoint_stats).toHaveBeenNthCalledWith(2, TENANT_ID, undefined);
  });
});
