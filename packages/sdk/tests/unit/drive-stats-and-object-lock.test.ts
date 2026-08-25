import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { AtlasInstance, AtlasInstanceConfig } from '@wisecom/atlas-types';
import { createAtlasInstance } from '@/atlas-instance.adapter';

const TENANT_ID = 'test-tenant-id';
const SITE_ID =
  'contoso.sharepoint.com,00000000-0000-0000-0000-000000000000,11111111-1111-1111-1111-111111111111';
const VALID_CONFIG: AtlasInstanceConfig = {
  tenantId: TENANT_ID,
  clientId: 'cid',
  clientSecret: 'csecret',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: 'ak',
  s3SecretKey: 'sk',
  encryptionPassphrase: 'passphrase',
};

const resolved = (value: unknown): Mock => vi.fn().mockResolvedValue(value);

const mock_stats = {
  get_bucket_stats: resolved({}),
  get_mailbox_stats: resolved({}),
  get_onedrive_stats: resolved({ total_files: 1 }),
  get_sharepoint_stats: resolved({ total_files: 2 }),
};
const mock_backup = { sync_mailbox: resolved({ snapshot: { id: 'snap-1' } }) };

const mocks: Record<string, unknown> = {
  StatsUseCase: mock_stats,
  BackupUseCase: mock_backup,
};

vi.mock('@/container', () => ({
  create_container_from_config: vi.fn(() => ({
    get: vi.fn((token: symbol) => mocks[token.description!] ?? {}),
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('drive statistics through the SDK (issue #165)', () => {
  let atlas: AtlasInstance;

  beforeEach(() => {
    atlas = createAtlasInstance(VALID_CONFIG);
  });

  it('scopes OneDrive stats to an owner and tenant-wide when the owner is omitted', async () => {
    await atlas.onedrive.getStats('owner-1');
    await atlas.onedrive.getStats();

    expect(mock_stats.get_onedrive_stats).toHaveBeenNthCalledWith(1, TENANT_ID, 'owner-1');
    expect(mock_stats.get_onedrive_stats).toHaveBeenNthCalledWith(2, TENANT_ID, undefined);
  });

  it('scopes SharePoint stats to a site and tenant-wide when the site is omitted', async () => {
    await atlas.sharepoint.getStats(SITE_ID);
    await atlas.sharepoint.getStats();

    expect(mock_stats.get_sharepoint_stats).toHaveBeenNthCalledWith(1, TENANT_ID, SITE_ID);
    expect(mock_stats.get_sharepoint_stats).toHaveBeenNthCalledWith(2, TENANT_ID, undefined);
  });
});

describe('Object Lock policy construction through the SDK (issue #165)', () => {
  let atlas: AtlasInstance;

  beforeEach(() => {
    atlas = createAtlasInstance(VALID_CONFIG);
  });

  it('derives retain_until from an object lock request', async () => {
    const before = Date.now();
    await atlas.outlook.backup('user@test.com', {
      object_lock_request: { mode: 'COMPLIANCE', retention_days: 30 },
    });

    const options = mock_backup.sync_mailbox.mock.calls[0]![2];
    expect(options.object_lock_policy.mode).toBe('COMPLIANCE');
    const retain_until = Date.parse(options.object_lock_policy.retain_until);
    expect(retain_until).toBeGreaterThanOrEqual(before + 29 * 24 * 60 * 60 * 1000);
    expect(retain_until).toBeLessThanOrEqual(Date.now() + 31 * 24 * 60 * 60 * 1000);
  });

  it('keeps a caller-supplied policy instead of recomputing it', async () => {
    await atlas.outlook.backup('user@test.com', {
      object_lock_request: { mode: 'GOVERNANCE', retention_days: 30 },
      object_lock_policy: {
        mode: 'GOVERNANCE',
        retain_until: '2030-01-01T00:00:00.000Z',
      },
    });

    const options = mock_backup.sync_mailbox.mock.calls[0]![2];
    expect(options.object_lock_policy.retain_until).toBe('2030-01-01T00:00:00.000Z');
  });

  it('leaves the policy unset when no retention was requested', async () => {
    await atlas.outlook.backup('user@test.com', { force_full: true });

    const options = mock_backup.sync_mailbox.mock.calls[0]![2];
    expect(options.object_lock_policy).toBeUndefined();
  });
});
