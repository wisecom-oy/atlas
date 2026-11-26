import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { AtlasInstance, AtlasInstanceConfig } from '@wisecom/atlas-types';
import { createAtlasInstance } from '@/atlas-instance.adapter';

// Issue #975: a host reads the Object Lock policy of a OneDrive or SharePoint recovery point from
// the backup result and from both snapshot listings, in the SDK's camelCase.

const OWNER_ID = '00000000-0000-0000-0000-000000000001';
const SITE_ID = '00000000-0000-0000-0000-000000000000,11111111-1111-1111-1111-111111111111';
const CONFIG: AtlasInstanceConfig = {
  tenantId: 'test-tenant-id',
  clientId: 'cid',
  clientSecret: 'csecret',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: 'ak',
  s3SecretKey: 'sk',
  encryptionPassphrase: '<redacted>'.repeat(2),
};

const RETAIN_UNTIL = '2099-01-01T00:00:00.000Z';
const STORED_LOCK = {
  requested: { mode: 'COMPLIANCE', retention_days: 30 },
  effective: { mode: 'COMPLIANCE', retain_until: RETAIN_UNTIL },
};
const SDK_LOCK = {
  requested: { mode: 'COMPLIANCE', retentionDays: 30 },
  effective: { mode: 'COMPLIANCE', retainUntil: RETAIN_UNTIL },
};

const resolved = (value: unknown): Mock => vi.fn().mockResolvedValue(value);

const snapshot = { snapshot_id: 'snap-1', object_lock: STORED_LOCK, entries: [] };
const summary = { snapshot_id: 'snap-1', object_lock: STORED_LOCK.effective };

const mocks: Record<string, unknown> = {
  OneDriveBackupUseCase: { backup_onedrive: resolved({ snapshot, object_lock: STORED_LOCK }) },
  OneDriveCatalogUseCase: {
    list_onedrive_snapshots: resolved([snapshot]),
    list_onedrive_snapshot_summaries: resolved([summary]),
  },
  SharePointSiteTreeBackupUseCase: {
    backup_site_tree: resolved([{ snapshot, object_lock: STORED_LOCK }]),
  },
  SharePointCatalogUseCase: {
    list_sharepoint_snapshots: resolved([snapshot]),
    list_sharepoint_snapshot_summaries: resolved([summary]),
  },
  UserIdentityResolver: { resolve_user: resolved(undefined) },
};

vi.mock('@/container', () => ({
  create_container_from_config: vi.fn(() => ({
    get: vi.fn((token: symbol) => mocks[token.description!] ?? {}),
  })),
}));

describe('drive Object Lock report through the SDK (#975)', () => {
  let atlas: AtlasInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    atlas = createAtlasInstance(CONFIG);
  });

  it('returns the OneDrive policy on the backup result and both listings', async () => {
    const result = await atlas.onedrive.backup(OWNER_ID);
    const snapshots = await atlas.onedrive.listSnapshots(OWNER_ID);
    const summaries = await atlas.onedrive.listSnapshotSummaries(OWNER_ID);

    expect(result.objectLock).toEqual(SDK_LOCK);
    expect(result.snapshot?.objectLock).toEqual(SDK_LOCK);
    expect(snapshots[0]?.objectLock).toEqual(SDK_LOCK);
    expect(summaries[0]?.objectLock).toEqual(SDK_LOCK.effective);
  });

  it('returns the SharePoint policy on the backup result and both listings', async () => {
    const [result] = await atlas.sharepoint.backup(SITE_ID);
    const snapshots = await atlas.sharepoint.listSnapshots(SITE_ID);
    const summaries = await atlas.sharepoint.listSnapshotSummaries(SITE_ID);

    expect(result?.objectLock).toEqual(SDK_LOCK);
    expect(snapshots[0]?.objectLock).toEqual(SDK_LOCK);
    expect(summaries[0]?.objectLock).toEqual(SDK_LOCK.effective);
  });
});
