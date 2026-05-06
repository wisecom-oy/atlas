import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  save_replication_status,
  load_replication_status,
  list_all_replication_status,
  list_replication_status_by_owner,
} from '@/services/replication/replication-status-repository';
import type { ReplicationStatusRecord } from '@atlas/types';
import { ReplicationStatus, ReplicationVerificationStatus } from '@atlas/types';
import type { TenantContext, ObjectStorage } from '@atlas/types';
import { stub_tenant_create_cipher } from '@atlas/types/testing/stub-tenant-create-cipher';

function make_storage(): ObjectStorage {
  return {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    delete_version: vi.fn(),
    exists: vi.fn(),
    list: vi.fn(),
    list_versions: vi.fn(),
    begin_multipart_upload: vi.fn().mockResolvedValue({
      upload_part: vi.fn(),
      complete: vi.fn(),
      abort: vi.fn(),
    }),
    copy: vi.fn(),
    abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
    probe_immutability: vi.fn(),
  };
}

function make_context(storage: ObjectStorage): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage,
    encrypt: vi.fn((data: Buffer) => Buffer.concat([Buffer.from('enc:'), data])),
    decrypt: vi.fn((data: Buffer) => Buffer.from(data.toString().replace('enc:', ''))),
    create_cipher: stub_tenant_create_cipher,
  };
}

function make_record(overrides: Partial<ReplicationStatusRecord> = {}): ReplicationStatusRecord {
  return {
    target_id: overrides.target_id ?? 'offsite',
    target_endpoint: overrides.target_endpoint ?? 'http://offsite:9000',
    snapshot_id: overrides.snapshot_id ?? 'snap-1',
    owner_id: overrides.owner_id ?? 'mbx-1',
    status: overrides.status ?? ReplicationStatus.COMPLETED,
    started_at: overrides.started_at ?? '2026-01-01T00:00:00Z',
    completed_at: overrides.completed_at ?? '2026-01-01T00:05:00Z',
    objects_total: overrides.objects_total ?? 10,
    objects_copied: overrides.objects_copied ?? 8,
    objects_skipped: overrides.objects_skipped ?? 2,
    objects_failed: overrides.objects_failed ?? 0,
    bytes_total: overrides.bytes_total ?? 1000,
    bytes_copied: overrides.bytes_copied ?? 800,
    verification_status: overrides.verification_status ?? ReplicationVerificationStatus.SKIPPED,
    source_manifest_checksum: overrides.source_manifest_checksum ?? 'src-checksum',
    replicated_manifest_checksum: overrides.replicated_manifest_checksum ?? 'rep-checksum',
  };
}

describe('replication-status-repository', () => {
  let storage: ObjectStorage;
  let ctx: TenantContext;

  beforeEach(() => {
    storage = make_storage();
    ctx = make_context(storage);
  });

  it('saves an encrypted status record', async () => {
    const record = make_record();
    await save_replication_status(ctx, record);

    expect(storage.put).toHaveBeenCalledOnce();
    const [key, data] = vi.mocked(storage.put).mock.calls[0]!;
    expect(key).toBe('_meta/replication/mbx-1/snap-1/offsite.json');
    expect(ctx.encrypt).toHaveBeenCalledWith(
      expect.objectContaining(Buffer.from(JSON.stringify(record))),
    );
    expect(data).toBeInstanceOf(Buffer);
  });

  it('loads and decrypts a status record', async () => {
    const record = make_record();
    const plaintext = Buffer.from(JSON.stringify(record));
    const encrypted = Buffer.concat([Buffer.from('enc:'), plaintext]);

    vi.mocked(storage.exists).mockResolvedValue(true);
    vi.mocked(storage.get).mockResolvedValue(encrypted);

    const loaded = await load_replication_status(ctx, 'mbx-1', 'snap-1', 'offsite');

    expect(loaded).toEqual(record);
  });

  it('returns undefined when status record does not exist', async () => {
    vi.mocked(storage.exists).mockResolvedValue(false);

    const loaded = await load_replication_status(ctx, 'mbx-1', 'snap-1', 'offsite');

    expect(loaded).toBeUndefined();
  });

  it('lists all status records by prefix', async () => {
    const record = make_record();
    const plaintext = Buffer.from(JSON.stringify(record));
    const encrypted = Buffer.concat([Buffer.from('enc:'), plaintext]);

    vi.mocked(storage.list).mockResolvedValue(['_meta/replication/mbx-1/snap-1/offsite.json']);
    vi.mocked(storage.exists).mockResolvedValue(true);
    vi.mocked(storage.get).mockResolvedValue(encrypted);

    const results = await list_all_replication_status(ctx);

    expect(results).toHaveLength(1);
    expect(results[0]!.target_id).toBe('offsite');
  });

  it('filters by owner prefix', async () => {
    const record = make_record({ owner_id: 'mbx-2' });
    const plaintext = Buffer.from(JSON.stringify(record));
    const encrypted = Buffer.concat([Buffer.from('enc:'), plaintext]);

    vi.mocked(storage.list).mockResolvedValue(['_meta/replication/mbx-2/snap-1/offsite.json']);
    vi.mocked(storage.exists).mockResolvedValue(true);
    vi.mocked(storage.get).mockResolvedValue(encrypted);

    const results = await list_replication_status_by_owner(ctx, 'mbx-2');

    expect(results).toHaveLength(1);
    expect(storage.list).toHaveBeenCalledWith('_meta/replication/mbx-2/');
  });
});
