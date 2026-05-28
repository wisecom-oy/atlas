/* eslint-disable @typescript-eslint/naming-convention */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AtlasInstance, AtlasInstanceConfig } from '@/ports/atlas/use-case.port';
import type { BackupUseCase, SyncResult } from '@/ports/backup/use-case.port';
import type { VerificationUseCase, VerificationResult } from '@/ports/verification/use-case.port';
import type { RestoreUseCase, RestoreResult } from '@/ports/restore/use-case.port';
import type { CatalogUseCase, MailboxSummary } from '@/ports/catalog/use-case.port';
import type { DeletionUseCase, DeletionResult } from '@/ports/deletion/use-case.port';
import type { StorageCheckUseCase, StorageCheckResult } from '@/ports/storage-check/use-case.port';
import type { SaveUseCase, SaveResult } from '@/ports/save/use-case.port';
import type { Manifest } from '@/domain/manifest';

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

const mock_backup: BackupUseCase = { sync_mailbox: vi.fn() };
const mock_verification: VerificationUseCase = { verify_snapshot_integrity: vi.fn() };
const mock_restore: RestoreUseCase = {
  restore_snapshot: vi.fn(),
  restore_mailbox: vi.fn(),
};
const mock_catalog: CatalogUseCase = {
  list_mailboxes: vi.fn(),
  list_snapshots: vi.fn(),
  get_snapshot_detail: vi.fn(),
  read_message: vi.fn(),
};
const mock_deletion: DeletionUseCase = {
  delete_mailbox_data: vi.fn(),
  delete_snapshot: vi.fn(),
  purge_tenant: vi.fn(),
};
const mock_storage_check: StorageCheckUseCase = { check_storage: vi.fn() };
const mock_save: SaveUseCase = {
  save_snapshot: vi.fn(),
  save_mailbox: vi.fn(),
};

vi.mock('@/container', () => ({
  create_container_from_config: vi.fn(() => ({
    get: vi.fn((token: symbol) => {
      const key = token.description;
      const map: Record<string, unknown> = {
        BackupUseCase: mock_backup,
        VerificationUseCase: mock_verification,
        RestoreUseCase: mock_restore,
        CatalogUseCase: mock_catalog,
        DeletionUseCase: mock_deletion,
        StorageCheckUseCase: mock_storage_check,
        SaveUseCase: mock_save,
      };
      return map[key!];
    }),
  })),
}));

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let createAtlasInstance: typeof import('@/adapters/sdk/atlas-instance.adapter').createAtlasInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import('@/adapters/sdk/atlas-instance.adapter');
  createAtlasInstance = mod.createAtlasInstance;
});

describe('createAtlasInstance', () => {
  let atlas: AtlasInstance;

  beforeEach(() => {
    atlas = createAtlasInstance(VALID_CONFIG);
  });

  it('throws when a required config field is missing', () => {
    const incomplete = { ...VALID_CONFIG, tenantId: '' };
    expect(() => createAtlasInstance(incomplete)).toThrow(/tenantId/);
  });

  it('defaults s3Region to us-east-1 when omitted', async () => {
    const { create_container_from_config } = await import('@/container');
    createAtlasInstance(VALID_CONFIG);
    const config_arg = vi.mocked(create_container_from_config).mock.calls[0]![0];
    expect(config_arg.s3_region).toBe('us-east-1');
  });

  it('maps camelCase config to internal snake_case AtlasConfig', async () => {
    const { create_container_from_config } = await import('@/container');
    createAtlasInstance(VALID_CONFIG);
    const config_arg = vi.mocked(create_container_from_config).mock.calls[0]![0];
    expect(config_arg.tenant_id).toBe(TENANT_ID);
    expect(config_arg.client_id).toBe('cid');
    expect(config_arg.client_secret).toBe('csecret');
    expect(config_arg.s3_endpoint).toBe('http://localhost:9000');
    expect(config_arg.s3_access_key).toBe('ak');
    expect(config_arg.s3_secret_key).toBe('sk');
    expect(config_arg.encryption_passphrase).toBe('passphrase');
  });

  // ---------------------------------------------------------------------------
  // backupMailbox
  // ---------------------------------------------------------------------------

  describe('backupMailbox', () => {
    it('delegates to BackupUseCase.sync_mailbox with bound tenant_id', async () => {
      const sync_result = { snapshot: { id: 'snap-1' } } as unknown as SyncResult;
      vi.mocked(mock_backup.sync_mailbox).mockResolvedValue(sync_result);

      const result = await atlas.backupMailbox('user@test.com', { force_full: true });

      expect(result).toBe(sync_result);
      expect(mock_backup.sync_mailbox).toHaveBeenCalledWith(TENANT_ID, 'user@test.com', {
        force_full: true,
      });
    });

    it('returns a Promise', () => {
      vi.mocked(mock_backup.sync_mailbox).mockResolvedValue({} as SyncResult);
      const result = atlas.backupMailbox('user@test.com');
      expect(result).toBeInstanceOf(Promise);
    });
  });

  // ---------------------------------------------------------------------------
  // verifySnapshot
  // ---------------------------------------------------------------------------

  describe('verifySnapshot', () => {
    it('delegates to VerificationUseCase with bound tenant_id', async () => {
      const verification_result: VerificationResult = {
        snapshot_id: 'snap-1',
        total_checked: 10,
        passed: 10,
        failed: [],
      };
      vi.mocked(mock_verification.verify_snapshot_integrity).mockResolvedValue(verification_result);

      const result = await atlas.verifySnapshot('snap-1');

      expect(result).toBe(verification_result);
      expect(mock_verification.verify_snapshot_integrity).toHaveBeenCalledWith(TENANT_ID, 'snap-1');
    });
  });

  // ---------------------------------------------------------------------------
  // restoreSnapshot
  // ---------------------------------------------------------------------------

  describe('restoreSnapshot', () => {
    it('delegates to RestoreUseCase.restore_snapshot with bound tenant_id', async () => {
      const restore_result = { restored_count: 5 } as unknown as RestoreResult;
      vi.mocked(mock_restore.restore_snapshot).mockResolvedValue(restore_result);

      const result = await atlas.restoreSnapshot('snap-1', { folder_name: 'Inbox' });

      expect(result).toBe(restore_result);
      expect(mock_restore.restore_snapshot).toHaveBeenCalledWith(TENANT_ID, 'snap-1', {
        folder_name: 'Inbox',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // restoreMailbox
  // ---------------------------------------------------------------------------

  describe('restoreMailbox', () => {
    it('delegates to RestoreUseCase.restore_mailbox with bound tenant_id', async () => {
      const restore_result = { restored_count: 50 } as unknown as RestoreResult;
      vi.mocked(mock_restore.restore_mailbox).mockResolvedValue(restore_result);

      const result = await atlas.restoreMailbox('user@test.com');

      expect(result).toBe(restore_result);
      expect(mock_restore.restore_mailbox).toHaveBeenCalledWith(
        TENANT_ID,
        'user@test.com',
        undefined,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // saveSnapshot
  // ---------------------------------------------------------------------------

  describe('saveSnapshot', () => {
    it('delegates to SaveUseCase.save_snapshot with bound tenant_id', async () => {
      const save_result = { saved_count: 7 } as unknown as SaveResult;
      vi.mocked(mock_save.save_snapshot).mockResolvedValue(save_result);

      const result = await atlas.saveSnapshot('snap-1', { folder_name: 'Inbox' });

      expect(result).toBe(save_result);
      expect(mock_save.save_snapshot).toHaveBeenCalledWith(TENANT_ID, 'snap-1', {
        folder_name: 'Inbox',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // saveMailbox
  // ---------------------------------------------------------------------------

  describe('saveMailbox', () => {
    it('delegates to SaveUseCase.save_mailbox with bound tenant_id', async () => {
      const save_result = { saved_count: 40 } as unknown as SaveResult;
      vi.mocked(mock_save.save_mailbox).mockResolvedValue(save_result);

      const result = await atlas.saveMailbox('user@test.com', { output_path: 'out.zip' });

      expect(result).toBe(save_result);
      expect(mock_save.save_mailbox).toHaveBeenCalledWith(TENANT_ID, 'user@test.com', {
        output_path: 'out.zip',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // catalog methods
  // ---------------------------------------------------------------------------

  describe('listMailboxes', () => {
    it('delegates with bound tenant_id', async () => {
      const summaries: MailboxSummary[] = [];
      vi.mocked(mock_catalog.list_mailboxes).mockResolvedValue(summaries);

      const result = await atlas.listMailboxes();

      expect(result).toBe(summaries);
      expect(mock_catalog.list_mailboxes).toHaveBeenCalledWith(TENANT_ID);
    });
  });

  describe('listSnapshots', () => {
    it('delegates with bound tenant_id and mailbox_id', async () => {
      const manifests: Manifest[] = [];
      vi.mocked(mock_catalog.list_snapshots).mockResolvedValue(manifests);

      const result = await atlas.listSnapshots('user@test.com');

      expect(result).toBe(manifests);
      expect(mock_catalog.list_snapshots).toHaveBeenCalledWith(TENANT_ID, 'user@test.com');
    });
  });

  describe('getSnapshotDetail', () => {
    it('delegates with bound tenant_id', async () => {
      vi.mocked(mock_catalog.get_snapshot_detail).mockResolvedValue(undefined);

      const result = await atlas.getSnapshotDetail('snap-99');

      expect(result).toBeUndefined();
      expect(mock_catalog.get_snapshot_detail).toHaveBeenCalledWith(TENANT_ID, 'snap-99');
    });
  });

  describe('readMessage', () => {
    it('delegates with bound tenant_id, snapshot_id, and message_ref', async () => {
      vi.mocked(mock_catalog.read_message).mockResolvedValue(undefined);

      const result = await atlas.readMessage('snap-1', 'msg-42');

      expect(result).toBeUndefined();
      expect(mock_catalog.read_message).toHaveBeenCalledWith(TENANT_ID, 'snap-1', 'msg-42');
    });
  });

  // ---------------------------------------------------------------------------
  // deletion methods
  // ---------------------------------------------------------------------------

  describe('deleteMailboxData', () => {
    it('delegates with bound tenant_id and mailbox_id', async () => {
      const deletion_result: DeletionResult = {
        deleted_objects: 10,
        deleted_manifests: 2,
        retained_objects: 0,
        retained_manifests: 0,
        failed_objects: 0,
        failed_manifests: 0,
      };
      vi.mocked(mock_deletion.delete_mailbox_data).mockResolvedValue(deletion_result);

      const result = await atlas.deleteMailboxData('user@test.com');

      expect(result).toBe(deletion_result);
      expect(mock_deletion.delete_mailbox_data).toHaveBeenCalledWith(TENANT_ID, 'user@test.com');
    });
  });

  describe('deleteSnapshot', () => {
    it('delegates with bound tenant_id and snapshot_id', async () => {
      const deletion_result: DeletionResult = {
        deleted_objects: 0,
        deleted_manifests: 1,
        retained_objects: 5,
        retained_manifests: 0,
        failed_objects: 0,
        failed_manifests: 0,
      };
      vi.mocked(mock_deletion.delete_snapshot).mockResolvedValue(deletion_result);

      const result = await atlas.deleteSnapshot('snap-1');

      expect(result).toBe(deletion_result);
      expect(mock_deletion.delete_snapshot).toHaveBeenCalledWith(TENANT_ID, 'snap-1');
    });
  });

  // ---------------------------------------------------------------------------
  // checkStorage
  // ---------------------------------------------------------------------------

  describe('checkStorage', () => {
    it('delegates with bound tenant_id', async () => {
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
  });

  // ---------------------------------------------------------------------------
  // async contract
  // ---------------------------------------------------------------------------

  describe('async contract', () => {
    it('every method returns a Promise', () => {
      vi.mocked(mock_backup.sync_mailbox).mockResolvedValue({} as SyncResult);
      vi.mocked(mock_verification.verify_snapshot_integrity).mockResolvedValue(
        {} as VerificationResult,
      );
      vi.mocked(mock_restore.restore_snapshot).mockResolvedValue({} as RestoreResult);
      vi.mocked(mock_restore.restore_mailbox).mockResolvedValue({} as RestoreResult);
      vi.mocked(mock_catalog.list_mailboxes).mockResolvedValue([]);
      vi.mocked(mock_catalog.list_snapshots).mockResolvedValue([]);
      vi.mocked(mock_catalog.get_snapshot_detail).mockResolvedValue(undefined);
      vi.mocked(mock_catalog.read_message).mockResolvedValue(undefined);
      vi.mocked(mock_deletion.delete_mailbox_data).mockResolvedValue({} as DeletionResult);
      vi.mocked(mock_deletion.delete_snapshot).mockResolvedValue({} as DeletionResult);
      vi.mocked(mock_storage_check.check_storage).mockResolvedValue({} as StorageCheckResult);
      vi.mocked(mock_save.save_snapshot).mockResolvedValue({} as SaveResult);
      vi.mocked(mock_save.save_mailbox).mockResolvedValue({} as SaveResult);

      expect(atlas.backupMailbox('m')).toBeInstanceOf(Promise);
      expect(atlas.verifySnapshot('s')).toBeInstanceOf(Promise);
      expect(atlas.restoreSnapshot('s')).toBeInstanceOf(Promise);
      expect(atlas.restoreMailbox('m')).toBeInstanceOf(Promise);
      expect(atlas.saveSnapshot('s')).toBeInstanceOf(Promise);
      expect(atlas.saveMailbox('m')).toBeInstanceOf(Promise);
      expect(atlas.listMailboxes()).toBeInstanceOf(Promise);
      expect(atlas.listSnapshots('m')).toBeInstanceOf(Promise);
      expect(atlas.getSnapshotDetail('s')).toBeInstanceOf(Promise);
      expect(atlas.readMessage('s', 'r')).toBeInstanceOf(Promise);
      expect(atlas.deleteMailboxData('m')).toBeInstanceOf(Promise);
      expect(atlas.deleteSnapshot('s')).toBeInstanceOf(Promise);
      expect(atlas.checkStorage()).toBeInstanceOf(Promise);
    });
  });
});
