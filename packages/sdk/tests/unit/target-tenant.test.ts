import { inspect } from 'node:util';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Container } from 'inversify';
import type * as M365Graph from '@wisecom/atlas-m365-graph';
import { AuthError, ConfigError } from '@wisecom/atlas-types';
import { create_tenant } from '@/target-tenant';
import { create_outlook_api } from '@/outlook-api.factory';
import { create_onedrive_api } from '@/onedrive-api.factory';

const create_container_from_config = vi.hoisted(() => vi.fn());
vi.mock('@/container', () => ({ create_container_from_config }));

const get_access_token = vi.hoisted(() => vi.fn());
vi.mock('@wisecom/atlas-m365-graph', async (load) => {
  const actual = await load<typeof M365Graph>();
  return {
    ...actual,
    bind_graph_client: (container: Container) =>
      container
        .bind(actual.GRAPH_AUTH_PROVIDER_TOKEN)
        .toConstantValue({ getAccessToken: get_access_token }),
  };
});

const SOURCE_CONFIG = { tenant_id: 'tenant-source', s3_endpoint: 'http://s3.example.com' };
const DESTINATION = {
  tenantId: 'contoso.onmicrosoft.com',
  clientId: '00000000-0000-0000-0000-000000000002',
  clientSecret: 'destination-secret-value',
};
const DEST_OBJECT_ID = 'oid-destination-john';

/** A container resolving services by their token's description, as the factories ask for them. */
function fake_container(services: Record<string, unknown>): Container & { disposed: boolean } {
  const container = {
    disposed: false,
    get: (token: symbol) => services[token.description!] ?? {},
    isBound: (token: symbol) => token.description! in services,
    unbindAllAsync: async () => {
      container.disposed = true;
    },
  };
  return container as unknown as Container & { disposed: boolean };
}

function source_and_target() {
  const source_restore = { restore_snapshot: vi.fn(), restore_onedrive: vi.fn() };
  const source_identity = { resolve_user: vi.fn() };
  const source = fake_container({
    AtlasConfig: SOURCE_CONFIG,
    RestoreUseCase: source_restore,
    OneDriveRestoreUseCase: source_restore,
    UserIdentityResolver: source_identity,
  });
  const target_restore = {
    restore_snapshot: vi.fn().mockResolvedValue({ snapshot_id: 'snap-1' }),
    restore_onedrive: vi.fn().mockResolvedValue({ snapshot_id: 'snap-1' }),
  };
  const target_graph = { resolve_user: vi.fn(async () => ({ object_id: DEST_OBJECT_ID })) };
  const target = fake_container({
    RestoreUseCase: target_restore,
    OneDriveRestoreUseCase: target_restore,
    GraphIdentityResolver: target_graph,
  });
  create_container_from_config.mockReturnValue(target);
  return { source, target, source_restore, source_identity, target_restore, target_graph };
}

beforeEach(() => {
  create_container_from_config.mockReset();
  get_access_token.mockReset();
});

describe('createTenant', () => {
  it('exposes the tenant and client ids but never the secret', () => {
    const tenant = create_tenant(DESTINATION);

    expect(tenant.tenantId).toBe(DESTINATION.tenantId);
    expect(tenant.clientId).toBe(DESTINATION.clientId);
    expect(JSON.stringify(tenant)).not.toContain(DESTINATION.clientSecret);
    expect(inspect(tenant, { showHidden: true, depth: 5 })).not.toContain(DESTINATION.clientSecret);
    expect(Object.values({ ...tenant })).not.toContain(DESTINATION.clientSecret);
  });

  it('rejects malformed credentials before any network call', () => {
    expect(() => create_tenant({ ...DESTINATION, tenantId: 'not a tenant' })).toThrow(ConfigError);
    expect(() => create_tenant({ ...DESTINATION, clientId: 'contoso' })).toThrow(/clientId/);
    expect(() => create_tenant({ ...DESTINATION, clientSecret: '' })).toThrow(/clientSecret/);
  });

  it('validate() throws AuthError when Entra ID refuses the credentials', async () => {
    get_access_token.mockRejectedValue(new Error('AADSTS7000215'));

    await expect(create_tenant(DESTINATION).validate()).rejects.toBeInstanceOf(AuthError);
  });

  it('validate() resolves once a token is issued', async () => {
    get_access_token.mockResolvedValue('token');

    await expect(create_tenant(DESTINATION).validate()).resolves.toBeUndefined();
  });
});

describe('restore with targetTenant', () => {
  it('reads the source backup and writes through the target tenant', async () => {
    const { source, target, source_restore, source_identity, target_restore, target_graph } =
      source_and_target();
    const api = create_outlook_api('tenant-source', source);

    await api.restore('snap-1', {
      targetMailbox: 'john.doe@example.com',
      targetTenant: create_tenant(DESTINATION),
    });

    expect(create_container_from_config).toHaveBeenCalledWith({
      ...SOURCE_CONFIG,
      tenant_id: DESTINATION.tenantId,
      client_id: DESTINATION.clientId,
      client_secret: DESTINATION.clientSecret,
    });
    expect(target_restore.restore_snapshot).toHaveBeenCalledWith(
      'tenant-source',
      'snap-1',
      expect.objectContaining({ target_mailbox: DEST_OBJECT_ID }),
    );
    expect(target_restore.restore_snapshot.mock.calls[0]![2]).not.toHaveProperty('target_tenant');
    expect(target_graph.resolve_user).toHaveBeenCalledWith('tenant-source', 'john.doe@example.com');
    expect(source_identity.resolve_user).not.toHaveBeenCalled();
    expect(source_restore.restore_snapshot).not.toHaveBeenCalled();
    expect(target.disposed).toBe(true);
  });

  it("reports the restore's storage requests to the instance's onStorageRequest observer", async () => {
    const add_middleware = vi.fn();
    const target_restore = { restore_snapshot: vi.fn().mockResolvedValue({ snapshot_id: 's' }) };
    const source = fake_container({
      AtlasConfig: SOURCE_CONFIG,
      AtlasSdkStorageObserver: vi.fn(),
    });
    create_container_from_config.mockReturnValue(
      fake_container({
        RestoreUseCase: target_restore,
        GraphIdentityResolver: { resolve_user: vi.fn() },
        S3Client: { middlewareStack: { add: add_middleware } },
      }),
    );

    await create_outlook_api('tenant-source', source).restore('snap-1', {
      targetMailbox: DEST_OBJECT_ID,
      targetTenant: create_tenant(DESTINATION),
    });

    expect(add_middleware).toHaveBeenCalled();
  });

  it('disposes the target container when the restore fails', async () => {
    const { source, target, target_restore } = source_and_target();
    target_restore.restore_onedrive.mockRejectedValue(new Error('Graph 503'));
    const api = create_onedrive_api('tenant-source', source);

    await expect(
      api.restore('oid-source-john', {
        snapshotId: 'snap-1',
        targetOwnerId: DEST_OBJECT_ID,
        targetTenant: create_tenant(DESTINATION),
      }),
    ).rejects.toThrow('Graph 503');
    expect(target.disposed).toBe(true);
  });

  it('refuses a targetTenant without an explicit target, building nothing', async () => {
    const { source } = source_and_target();
    const api = create_outlook_api('tenant-source', source);

    await expect(
      api.restore('snap-1', { targetTenant: create_tenant(DESTINATION) }),
    ).rejects.toThrow(/needs an explicit target/);
    expect(create_container_from_config).not.toHaveBeenCalled();
  });

  it('refuses a targetTenant that createTenant did not return', async () => {
    const { source } = source_and_target();
    const api = create_outlook_api('tenant-source', source);
    const forged = {
      tenantId: DESTINATION.tenantId,
      clientId: DESTINATION.clientId,
      validate: vi.fn(),
    };

    await expect(
      api.restore('snap-1', { targetMailbox: DEST_OBJECT_ID, targetTenant: forged }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(create_container_from_config).not.toHaveBeenCalled();
  });

  it('restores within the instance tenant when no targetTenant is given', async () => {
    const { source, source_restore } = source_and_target();
    source_restore.restore_onedrive.mockResolvedValue({ snapshot_id: 'snap-1' });
    const api = create_onedrive_api('tenant-source', source);

    await api.restore('oid-source-john', { snapshotId: 'snap-1' });

    expect(source_restore.restore_onedrive).toHaveBeenCalledOnce();
    expect(create_container_from_config).not.toHaveBeenCalled();
  });
});
