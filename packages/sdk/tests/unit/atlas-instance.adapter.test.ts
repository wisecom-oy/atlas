/* eslint-disable @typescript-eslint/naming-convention */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  AtlasInstance,
  AtlasInstanceConfig,
  SyncResult,
  VerificationResult,
  StorageCheckResult,
} from '@atlas/types';

const TENANT_ID = 'test-tenant-id';
const VALID_CONFIG: AtlasInstanceConfig = {
  tenantId: TENANT_ID,
  clientId: 'cid',
  clientSecret: 'csecret',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: 'ak',
  s3SecretKey: 'sk',
  encryptionPassphrase: 'passphrase',
};

const mock_backup = { sync_mailbox: vi.fn() };
const mock_verification = { verify_snapshot_integrity: vi.fn() };
const mock_restore = { restore_snapshot: vi.fn(), restore_mailbox: vi.fn() };
const mock_catalog = {
  list_mailboxes: vi.fn(),
  list_snapshots: vi.fn(),
  get_snapshot_detail: vi.fn(),
  read_message: vi.fn(),
};
const mock_deletion = {
  delete_mailbox_data: vi.fn(),
  delete_snapshot: vi.fn(),
  purge_tenant: vi.fn(),
};
const mock_storage_check = { check_storage: vi.fn() };
const mock_save = { save_snapshot: vi.fn(), save_mailbox: vi.fn() };
const mock_stats = { get_bucket_stats: vi.fn(), get_mailbox_stats: vi.fn() };
const mock_status = { check_mailbox_status: vi.fn() };
const mock_replication = {
  replicate_snapshot: vi.fn(),
  replicate_mailbox: vi.fn(),
  rehydrate_snapshot: vi.fn(),
  rehydrate_mailbox: vi.fn(),
  rehydrate_tenant: vi.fn(),
  get_replication_status: vi.fn(),
  get_replication_status_by_owner: vi.fn(),
};
const mock_onedrive_backup = { backup_onedrive: vi.fn() };
const mock_onedrive_verification = { verify_onedrive_snapshot: vi.fn() };
const mock_onedrive_catalog = {
  list_onedrive_snapshots: vi.fn(),
  list_onedrive_file_versions: vi.fn(),
};
const mock_onedrive_restore = { restore_onedrive: vi.fn() };
const mock_sharepoint_backup = { backup_site: vi.fn() };
const mock_sharepoint_verification = { verify_sharepoint_snapshot: vi.fn() };
const mock_onedrive_save = { save_snapshot: vi.fn() };
const mock_onedrive_deletion = { delete_owner_data: vi.fn(), delete_snapshot: vi.fn() };
const mock_onedrive_replication = {
  replicate_owner: vi.fn(),
  replicate_all_owner_snapshots: vi.fn(),
  rehydrate_owner_snapshot: vi.fn(),
  rehydrate_owner: vi.fn(),
};
const mock_onedrive_status = { check_onedrive_status: vi.fn() };
const mock_sharepoint_catalog = {
  list_sharepoint_snapshots: vi.fn(),
  list_sharepoint_file_versions: vi.fn(),
};
const mock_sharepoint_restore = { restore_sharepoint: vi.fn() };
const mock_sharepoint_save = { save_snapshot: vi.fn() };
const mock_sharepoint_replication = {
  replicate_site: vi.fn(),
  replicate_all_site_snapshots: vi.fn(),
  rehydrate_site_snapshot: vi.fn(),
  rehydrate_site: vi.fn(),
};
const mock_sharepoint_deletion = { delete_site_data: vi.fn(), delete_snapshot: vi.fn() };
const mock_sharepoint_status = { check_sharepoint_status: vi.fn() };
const mock_sharepoint_connector = { list_sites: vi.fn(), resolve_site: vi.fn() };
const mock_discovery = { list_tenant_mailboxes: vi.fn() };
const mock_identity_resolver = { resolve_user: vi.fn() };
const mock_identity_registry = { load: vi.fn() };
const mock_tenant_factory = { create: vi.fn() };

vi.mock('@/container', () => ({
  create_container_from_config: vi.fn(() => ({
    get: vi.fn((token: symbol) => {
      const map: Record<string, unknown> = {
        BackupUseCase: mock_backup,
        VerificationUseCase: mock_verification,
        RestoreUseCase: mock_restore,
        CatalogUseCase: mock_catalog,
        DeletionUseCase: mock_deletion,
        StorageCheckUseCase: mock_storage_check,
        SaveUseCase: mock_save,
        StatsUseCase: mock_stats,
        StatusUseCase: mock_status,
        ReplicationUseCase: mock_replication,
        OneDriveBackupUseCase: mock_onedrive_backup,
        OneDriveVerificationUseCase: mock_onedrive_verification,
        OneDriveCatalogUseCase: mock_onedrive_catalog,
        OneDriveRestoreUseCase: mock_onedrive_restore,
        OneDriveSaveUseCase: mock_onedrive_save,
        OneDriveDeletionUseCase: mock_onedrive_deletion,
        OneDriveReplicationUseCase: mock_onedrive_replication,
        OneDriveStatusUseCase: mock_onedrive_status,
        SharePointBackupUseCase: mock_sharepoint_backup,
        SharePointVerificationUseCase: mock_sharepoint_verification,
        SharePointCatalogUseCase: mock_sharepoint_catalog,
        SharePointRestoreUseCase: mock_sharepoint_restore,
        SharePointSaveUseCase: mock_sharepoint_save,
        SharePointReplicationUseCase: mock_sharepoint_replication,
        SharePointDeletionUseCase: mock_sharepoint_deletion,
        SharePointStatusUseCase: mock_sharepoint_status,
        SharePointSiteConnector: mock_sharepoint_connector,
        MailboxDiscoveryService: mock_discovery,
        UserIdentityResolver: mock_identity_resolver,
        IdentityRegistryRepository: mock_identity_registry,
        TenantContextFactory: mock_tenant_factory,
      };
      return map[token.description!];
    }),
  })),
}));

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let createAtlasInstance: typeof import('@/atlas-instance.adapter').createAtlasInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  createAtlasInstance = (await import('@/atlas-instance.adapter')).createAtlasInstance;
});

describe('createAtlasInstance', () => {
  let atlas: AtlasInstance;

  beforeEach(() => {
    atlas = createAtlasInstance(VALID_CONFIG);
  });

  it('validates config and maps camelCase fields to snake_case AtlasConfig', async () => {
    expect(() => createAtlasInstance({ ...VALID_CONFIG, tenantId: '' })).toThrow(/tenantId/);

    const { create_container_from_config } = await import('@/container');
    createAtlasInstance(VALID_CONFIG);
    const config_arg = vi.mocked(create_container_from_config).mock.calls[0]![0];
    expect(config_arg.s3_region).toBe('us-east-1');
    expect(config_arg.tenant_id).toBe(TENANT_ID);
    expect(config_arg.client_id).toBe('cid');
    expect(config_arg.s3_endpoint).toBe('http://localhost:9000');
    expect(config_arg.encryption_passphrase).toBe('passphrase');
  });

  describe('outlook', () => {
    it('backup delegates to BackupUseCase.sync_mailbox with bound tenant_id', async () => {
      const sync_result = { snapshot: { id: 'snap-1' } } as unknown as SyncResult;
      vi.mocked(mock_backup.sync_mailbox).mockResolvedValue(sync_result);

      const result = await atlas.outlook.backup('user@test.com', { force_full: true });

      expect(result).toMatchObject(sync_result);
      expect(result).toHaveProperty('graph_cost');
      expect(mock_backup.sync_mailbox).toHaveBeenCalledWith(TENANT_ID, 'user@test.com', {
        force_full: true,
      });
    });

    it('verify delegates to VerificationUseCase with bound tenant_id', async () => {
      const verification_result = {
        snapshot_id: 'snap-1',
        total_checked: 10,
        passed: 10,
        failed: [],
      } as VerificationResult;
      vi.mocked(mock_verification.verify_snapshot_integrity).mockResolvedValue(verification_result);

      const result = await atlas.outlook.verify('snap-1');

      expect(result).toBe(verification_result);
      expect(mock_verification.verify_snapshot_integrity).toHaveBeenCalledWith(TENANT_ID, 'snap-1');
    });
  });

  describe('onedrive', () => {
    it('backup delegates to OneDriveBackupUseCase with bound tenant_id', async () => {
      const backup_result = { snapshot_id: 'od-snap-1' };
      vi.mocked(mock_onedrive_backup.backup_onedrive).mockResolvedValue(backup_result);

      const result = await atlas.onedrive.backup('owner-1', { force_full: true });

      expect(result).toBe(backup_result);
      expect(mock_onedrive_backup.backup_onedrive).toHaveBeenCalledWith(TENANT_ID, 'owner-1', {
        force_full: true,
      });
    });

    it('verify delegates to OneDriveVerificationUseCase with bound tenant_id', async () => {
      const verify_result = { snapshot_id: 'od-snap-1', passed: 5, failed: [] };
      vi.mocked(mock_onedrive_verification.verify_onedrive_snapshot).mockResolvedValue(
        verify_result,
      );

      const result = await atlas.onedrive.verify('owner-1', 'od-snap-1');

      expect(result).toBe(verify_result);
      expect(mock_onedrive_verification.verify_onedrive_snapshot).toHaveBeenCalledWith(
        TENANT_ID,
        'owner-1',
        'od-snap-1',
      );
    });
  });

  describe('sharepoint', () => {
    it('backup delegates to SharePointBackupUseCase with bound tenant_id', async () => {
      const backup_result = { snapshot_id: 'sp-snap-1' };
      vi.mocked(mock_sharepoint_backup.backup_site).mockResolvedValue(backup_result);

      const result = await atlas.sharepoint.backup('site-1', { force_full: true });

      expect(result).toBe(backup_result);
      expect(mock_sharepoint_backup.backup_site).toHaveBeenCalledWith(TENANT_ID, 'site-1', {
        force_full: true,
      });
    });

    it('verify delegates to SharePointVerificationUseCase with bound tenant_id', async () => {
      const verify_result = { snapshot_id: 'sp-snap-1', passed: 3, failed: [] };
      vi.mocked(mock_sharepoint_verification.verify_sharepoint_snapshot).mockResolvedValue(
        verify_result,
      );

      const result = await atlas.sharepoint.verify('site-1', 'sp-snap-1');

      expect(result).toBe(verify_result);
      expect(mock_sharepoint_verification.verify_sharepoint_snapshot).toHaveBeenCalledWith(
        TENANT_ID,
        'site-1',
        'sp-snap-1',
      );
    });
  });

  describe('cross-cutting methods', () => {
    it('checkStorage delegates to StorageCheckUseCase with bound tenant_id', async () => {
      const check_result: StorageCheckResult = {
        bucket: 'atlas-test-tenant-id',
        reachable: true,
        versioning_enabled: true,
        object_lock_enabled: true,
        mode_supported: true,
      };
      vi.mocked(mock_storage_check.check_storage).mockResolvedValue(check_result);

      const result = await atlas.checkStorage({ mode: 'GOVERNANCE', retention_days: 30 });

      expect(result).toBe(check_result);
      expect(mock_storage_check.check_storage).toHaveBeenCalledWith(TENANT_ID, {
        mode: 'GOVERNANCE',
        retention_days: 30,
      });
    });

    it('getBucketStats delegates to StatsUseCase with bound tenant_id', async () => {
      const stats_result = { total_objects: 100, total_bytes: 5000 };
      vi.mocked(mock_stats.get_bucket_stats).mockResolvedValue(stats_result);

      expect(await atlas.getBucketStats()).toBe(stats_result);
      expect(mock_stats.get_bucket_stats).toHaveBeenCalledWith(TENANT_ID);
    });

    it('replicateSnapshot delegates to ReplicationUseCase with bound tenant_id', async () => {
      const targets = [{ bucket: 'replica-bucket', region: 'us-west-2' }];
      const replication_result = [{ snapshot_id: 'snap-1', status: 'completed' }];
      vi.mocked(mock_replication.replicate_snapshot).mockResolvedValue(replication_result);

      expect(await atlas.replicateSnapshot('snap-1', targets)).toBe(replication_result);
      expect(mock_replication.replicate_snapshot).toHaveBeenCalledWith(
        TENANT_ID,
        'snap-1',
        targets,
      );
    });
  });
});
