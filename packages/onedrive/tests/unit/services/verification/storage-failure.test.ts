import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { TenantContext, TenantContextFactory } from '@wisecom/atlas-types';
import { stub_encrypted_object_store } from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import type { DriveManifestEntry, DriveSnapshotManifest } from '@wisecom/atlas-drive/drive-ports';
import { verify_drive_snapshot } from '@wisecom/atlas-drive/verification/verify-snapshot';

const OWNER_ID = '00000000-0000-0000-0000-000000000001';
const CONTENT = Buffer.from('file-content');
const store = stub_encrypted_object_store();

function make_entry(file_id: string): DriveManifestEntry {
  return {
    file_id,
    drive_id: 'drive-1',
    file_name: `${file_id}.docx`,
    parent_path: '/Documents',
    size_bytes: CONTENT.length,
    storage_key: `onedrive/data/${OWNER_ID}/${file_id}`,
    checksum: createHash('sha256').update(CONTENT).digest('hex'),
    backup_at: '2026-03-02T00:00:00.000Z',
    change_type: 'created',
  };
}

function verify(entries: DriveManifestEntry[], storage: Record<string, unknown>) {
  const ctx = {
    storage,
    create_decipher: store.create_decipher,
    destroy: vi.fn(),
  } as unknown as TenantContext;
  const manifest = {
    snapshot_id: 'snap-1',
    created_at: new Date('2026-03-02T00:00:00Z'),
    entries,
  } as unknown as DriveSnapshotManifest;
  return verify_drive_snapshot(
    {
      workload: 'onedrive',
      tenant_factory: { create_readonly: async () => ctx } as unknown as TenantContextFactory,
      manifests: {
        workload: 'OneDrive',
        find_by_snapshot: async () => manifest,
        list_snapshots: async () => [manifest],
      },
      list_indexes: async () => [],
    },
    'tenant-1',
    OWNER_ID,
    'snap-1',
  );
}

describe('drive verify separates damage from storage failures (issue #439)', () => {
  it('counts an absent blob and a blob failing its auth tag as failed', async () => {
    const tampered = store.encrypt(CONTENT);
    tampered[tampered.length - 1]! ^= 0xff;
    const blobs: Record<string, Buffer> = { tampered, intact: store.encrypt(CONTENT) };
    const blob_of = (key: string): Buffer | undefined => blobs[key.split('/').pop()!];

    const result = await verify(['absent', 'tampered', 'intact'].map(make_entry), {
      get_stream: async (key: string) => {
        const blob = blob_of(key);
        if (!blob) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        return store.stream(blob);
      },
    });

    expect(result.failed_file_ids).toEqual(['absent', 'tampered']);
    expect(result.passed).toBe(1);
  });

  it('propagates a 403 from the read', async () => {
    const denied = Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } });

    await expect(
      verify([make_entry('a')], { get_stream: vi.fn().mockRejectedValue(denied) }),
    ).rejects.toBe(denied);
  });

  it('propagates a network failure while reading the blob', async () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

    await expect(
      verify([make_entry('a')], { get_stream: vi.fn().mockRejectedValue(reset) }),
    ).rejects.toBe(reset);
  });
});
