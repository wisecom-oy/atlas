import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AtlasInstance, AtlasInstanceConfig } from '@wisecom/atlas-types';
import { createAtlasInstance } from '@/atlas-instance.adapter';

const MAILBOX_ID = '00000000-0000-0000-0000-000000000001';
const VALID_CONFIG: AtlasInstanceConfig = {
  tenantId: 'test-tenant-id',
  clientId: 'cid',
  clientSecret: 'csecret',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: 'ak',
  s3SecretKey: 'sk',
  encryptionPassphrase: '<redacted>'.repeat(2),
};

const CREATED_AT = new Date('2026-01-15T10:00:00Z');
const manifest = {
  snapshot_id: 'snap-1',
  owner_id: MAILBOX_ID,
  created_at: CREATED_AT,
  total_objects: 2,
  total_size_bytes: 1024,
  entries: [],
};

const mock_catalog = {
  list_snapshots: vi.fn().mockResolvedValue([manifest]),
  get_snapshot_detail: vi.fn().mockResolvedValue(manifest),
};
const mocks: Record<string, unknown> = { CatalogUseCase: mock_catalog };

vi.mock('@/container', () => ({
  create_container_from_config: vi.fn(() => ({
    get: vi.fn((token: symbol) => mocks[token.description!] ?? {}),
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Outlook snapshot createdAt through the SDK (issue #441)', () => {
  let atlas: AtlasInstance;

  beforeEach(() => {
    atlas = createAtlasInstance(VALID_CONFIG);
  });

  it('returns createdAt as a Date from listSnapshots', async () => {
    const [snapshot] = await atlas.outlook.listSnapshots(MAILBOX_ID);

    expect(snapshot!.createdAt).toBeInstanceOf(Date);
    expect(snapshot!.createdAt.getTime()).toBe(CREATED_AT.getTime());
  });

  it('returns createdAt as a Date from getSnapshotDetail', async () => {
    const snapshot = await atlas.outlook.getSnapshotDetail('snap-1');

    expect(snapshot!.createdAt).toBeInstanceOf(Date);
    expect(snapshot!.createdAt.getTime()).toBe(CREATED_AT.getTime());
  });
});
