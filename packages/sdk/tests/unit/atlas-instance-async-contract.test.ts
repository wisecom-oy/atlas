/* eslint-disable @typescript-eslint/naming-convention */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AtlasInstance, AtlasInstanceConfig } from '@atlas/types';

const VALID_CONFIG: AtlasInstanceConfig = {
  tenantId: 'test-tenant-id',
  clientId: 'cid',
  clientSecret: 'csecret',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: 'ak',
  s3SecretKey: 'sk',
  encryptionPassphrase: 'passphrase',
};

const resolved = (value: unknown) => vi.fn().mockResolvedValue(value);

const mocks: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {
  BackupUseCase: { sync_mailbox: resolved({}) },
  VerificationUseCase: { verify_snapshot_integrity: resolved({}) },
  RestoreUseCase: { restore_snapshot: resolved({}), restore_mailbox: resolved({}) },
  CatalogUseCase: {
    list_mailboxes: resolved([]),
    list_snapshots: resolved([]),
    get_snapshot_detail: resolved(undefined),
    read_message: resolved(undefined),
  },
  DeletionUseCase: {
    delete_mailbox_data: resolved({}),
    delete_snapshot: resolved({}),
    purge_tenant: resolved({}),
  },
  StorageCheckUseCase: { check_storage: resolved({}) },
  SaveUseCase: { save_snapshot: resolved({}), save_mailbox: resolved({}) },
  StatsUseCase: { get_bucket_stats: resolved({}), get_mailbox_stats: resolved({}) },
  StatusUseCase: { check_mailbox_status: resolved({}) },
  MailboxDiscoveryService: { list_tenant_mailboxes: resolved([]) },
  ReplicationUseCase: {
    replicate_snapshot: resolved([]),
    replicate_mailbox: resolved([]),
    rehydrate_snapshot: resolved({}),
    rehydrate_mailbox: resolved({}),
    rehydrate_tenant: resolved({}),
    get_replication_status: resolved([]),
    get_replication_status_by_owner: resolved([]),
  },
  OneDriveBackupUseCase: { backup_onedrive: resolved({}) },
  OneDriveVerificationUseCase: { verify_onedrive_snapshot: resolved({}) },
  OneDriveCatalogUseCase: {
    list_onedrive_snapshots: resolved([]),
    list_onedrive_file_versions: resolved([]),
  },
  OneDriveRestoreUseCase: { restore_onedrive: resolved({}) },
  OneDriveSaveUseCase: { save_snapshot: resolved({}) },
  OneDriveDeletionUseCase: { delete_owner_data: resolved({}), delete_snapshot: resolved({}) },
  OneDriveReplicationUseCase: {
    replicate_owner: resolved([]),
    replicate_all_owner_snapshots: resolved([]),
    rehydrate_owner_snapshot: resolved({}),
    rehydrate_owner: resolved({}),
  },
  OneDriveStatusUseCase: { check_onedrive_status: resolved({}) },
  SharePointBackupUseCase: { backup_site: resolved({}) },
  SharePointVerificationUseCase: { verify_sharepoint_snapshot: resolved({}) },
  SharePointCatalogUseCase: {
    list_sharepoint_snapshots: resolved([]),
    list_sharepoint_file_versions: resolved([]),
  },
  SharePointRestoreUseCase: { restore_sharepoint: resolved({}) },
  SharePointSaveUseCase: { save_snapshot: resolved({}) },
  SharePointReplicationUseCase: {
    replicate_site: resolved([]),
    replicate_all_site_snapshots: resolved([]),
    rehydrate_site_snapshot: resolved({}),
    rehydrate_site: resolved({}),
  },
  SharePointDeletionUseCase: { delete_site_data: resolved({}), delete_snapshot: resolved({}) },
  SharePointStatusUseCase: { check_sharepoint_status: resolved({}) },
  SharePointSiteConnector: { list_sites: resolved([]), resolve_site: resolved({}) },
  UserIdentityResolver: { resolve_user: resolved({}) },
  IdentityRegistryRepository: { load: resolved(undefined) },
  TenantContextFactory: { create: resolved({}) },
};

vi.mock('@/container', () => ({
  create_container_from_config: vi.fn(() => ({
    get: vi.fn((token: symbol) => mocks[token.description!]),
  })),
}));

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let createAtlasInstance: typeof import('@/atlas-instance.adapter').createAtlasInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  createAtlasInstance = (await import('@/atlas-instance.adapter')).createAtlasInstance;
});

describe('createAtlasInstance — async contract', () => {
  let atlas: AtlasInstance;

  beforeEach(() => {
    atlas = createAtlasInstance(VALID_CONFIG);
  });

  it('every method on every sub-API returns a Promise', () => {
    const source = { bucket: 'src-bucket', region: 'us-east-1' };
    const targets = [source];
    for (const call of [
      () => atlas.outlook.backup('m'),
      () => atlas.outlook.verify('s'),
      () => atlas.outlook.restore('s'),
      () => atlas.outlook.restoreMailbox('m'),
      () => atlas.outlook.save('s'),
      () => atlas.outlook.saveMailbox('m'),
      () => atlas.outlook.listMailboxes(),
      () => atlas.outlook.listSnapshots('m'),
      () => atlas.outlook.getSnapshotDetail('s'),
      () => atlas.outlook.readMessage('s', 'r'),
      () => atlas.outlook.deleteMailboxData('m'),
      () => atlas.outlook.deleteSnapshot('s'),
      () => atlas.outlook.purgeTenantData(),
      () => atlas.outlook.getMailboxStats('m'),
      () => atlas.outlook.checkMailboxStatus('m'),
      () => atlas.outlook.listAvailableMailboxes(),
      () => atlas.onedrive.backup('o'),
      () => atlas.onedrive.verify('o', 's'),
      () => atlas.onedrive.restore('o', { snapshot_id: 's' }),
      () => atlas.onedrive.save('o', { snapshot_id: 's' }),
      () => atlas.onedrive.listSnapshots('o'),
      () => atlas.onedrive.listFileVersions('o', 'file-ref'),
      () => atlas.onedrive.deleteOwnerData('o'),
      () => atlas.onedrive.deleteSnapshot('o', 's'),
      () => atlas.onedrive.checkStatus('o'),
      () => atlas.onedrive.replicateSnapshot('o', 's', targets),
      () => atlas.onedrive.replicateAll('o', targets),
      () => atlas.onedrive.rehydrateSnapshot('o', 's', source),
      () => atlas.onedrive.rehydrateOwner('o', source),
      () => atlas.sharepoint.backup('site'),
      () => atlas.sharepoint.verify('site', 's'),
      () => atlas.sharepoint.restore('site', { snapshot_id: 's' }),
      () => atlas.sharepoint.save('site', { snapshot_id: 's' }),
      () => atlas.sharepoint.listSnapshots('site'),
      () => atlas.sharepoint.listFileVersions('site', 'f'),
      () => atlas.sharepoint.listSites(),
      () => atlas.sharepoint.resolveSite('url'),
      () => atlas.sharepoint.deleteSiteData('site'),
      () => atlas.sharepoint.deleteSnapshot('site', 's'),
      () => atlas.sharepoint.checkStatus('site'),
      () => atlas.sharepoint.replicateSnapshot('site', 's', targets),
      () => atlas.sharepoint.replicateAll('site', targets),
      () => atlas.sharepoint.rehydrateSnapshot('site', 's', source),
      () => atlas.sharepoint.rehydrateSite('site', source),
      () => atlas.checkStorage(),
      () => atlas.getBucketStats(),
      () => atlas.resolveUser('alice@test.com'),
      () => atlas.listUsers(),
      () => atlas.replicateSnapshot('s', targets),
      () => atlas.replicateMailbox('m', targets),
      () => atlas.rehydrateSnapshot('s', source),
      () => atlas.rehydrateMailbox('m', source),
      () => atlas.rehydrateTenant(source),
      () => atlas.getReplicationStatus('s'),
      () => atlas.getReplicationStatusByMailbox('m'),
    ]) {
      expect(call()).toBeInstanceOf(Promise);
    }
  });
});
