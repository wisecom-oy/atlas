import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type {
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveSaveService } from '@/services/save/save.service';

const CONTENT = Buffer.from('file-content');

function make_entry(): OneDriveManifestEntry {
  return {
    file_id: 'file-1',
    drive_id: 'drive-1',
    file_name: 'report.txt',
    parent_path: '/Documents',
    size_bytes: CONTENT.length,
    change_type: 'updated',
    backup_at: '2026-03-15T10:00:00.000Z',
    storage_key: 'onedrive/data/owner-1/file-1',
    checksum: '',
  };
}

describe('OneDrive save to a stream target', () => {
  it('destroys an interrupted stream without finalizing a complete archive', async () => {
    const sink = new PassThrough();
    sink.resume();
    let interrupted = false;
    const ctx = {
      storage: {
        get: vi.fn().mockImplementation(async () => {
          interrupted = true;
          return CONTENT;
        }),
      },
      decrypt: vi.fn((content: Buffer) => content),
      destroy: vi.fn(),
    } as unknown as TenantContext;
    const manifest: OneDriveSnapshotManifest = {
      id: 'manifest-1',
      tenant_id: 'tenant-1',
      snapshot_id: 'snapshot-1',
      owner_id: 'owner-1',
      total_size_bytes: CONTENT.length,
      created_at: new Date('2026-03-15T10:00:00.000Z'),
      total_files: 1,
      entries: [make_entry()],
    };
    const service = new OneDriveSaveService(
      { create: vi.fn().mockResolvedValue(ctx) } as unknown as TenantContextFactory,
      {
        find_by_snapshot: vi.fn().mockResolvedValue(manifest),
        list_snapshots_by_owner: vi.fn().mockResolvedValue([manifest]),
      } as unknown as OneDriveManifestRepository,
    );

    const result = await service.save_snapshot('tenant-1', 'owner-1', {
      snapshot_id: 'snapshot-1',
      output: sink,
      skip_integrity_check: true,
      should_interrupt: () => interrupted,
    });

    expect(result).toMatchObject({ files_saved: 1, interrupted: true });
    expect(sink.destroyed).toBe(true);
    expect(sink.writableEnded).toBe(false);
  });

  it('destroys the stream when tenant setup fails', async () => {
    const sink = new PassThrough();
    const service = new OneDriveSaveService(
      {
        create: vi.fn().mockRejectedValue(new Error('tenant unavailable')),
      } as unknown as TenantContextFactory,
      {} as OneDriveManifestRepository,
    );

    await expect(
      service.save_snapshot('tenant-1', 'owner-1', {
        snapshot_id: 'snapshot-1',
        output: sink,
      }),
    ).rejects.toThrow('tenant unavailable');

    expect(sink.destroyed).toBe(true);
    expect(sink.writableEnded).toBe(false);
  });

  it('destroys the stream when reading the manifest fails', async () => {
    const sink = new PassThrough();
    const ctx = { destroy: vi.fn() } as unknown as TenantContext;
    const service = new OneDriveSaveService(
      { create: vi.fn().mockResolvedValue(ctx) } as unknown as TenantContextFactory,
      {
        find_by_snapshot: vi.fn().mockRejectedValue(new Error('manifest unavailable')),
      } as unknown as OneDriveManifestRepository,
    );

    await expect(
      service.save_snapshot('tenant-1', 'owner-1', {
        snapshot_id: 'snapshot-1',
        output: sink,
      }),
    ).rejects.toThrow('manifest unavailable');

    expect(sink.destroyed).toBe(true);
    expect(sink.writableEnded).toBe(false);
  });
});
