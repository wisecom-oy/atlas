import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  SharePointManifestEntry,
  SharePointManifestRepository,
  SharePointSiteConnector,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { SharePointRestoreService } from '@/services/sharepoint-restore.service';

vi.mock('@/services/sharepoint-restore-streaming', () => ({
  should_stream_restore: vi.fn().mockReturnValue(false),
  stream_decrypt_from_storage: vi.fn(),
  verify_streaming_checksum: vi.fn().mockReturnValue(true),
}));

const CONTENT = Buffer.from('restored-content');

function make_entry(file_id: string): SharePointManifestEntry {
  return {
    file_id,
    drive_id: 'drive-1',
    file_name: `${file_id}.txt`,
    parent_path: '/Documents',
    size_bytes: CONTENT.length,
    change_type: 'created',
    backup_at: '2026-08-17T00:00:00.000Z',
    storage_key: `sharepoint/data/site-1/${file_id}`,
    checksum: createHash('sha256').update(CONTENT).digest('hex'),
  };
}

describe('SharePoint restore cancellation', () => {
  it('finishes the current file then stops with partial counts', async () => {
    let interrupted = false;
    const context = {
      storage: { get: vi.fn().mockResolvedValue(CONTENT) },
      decrypt: vi.fn((content: Buffer) => content),
      destroy: vi.fn(),
    } as unknown as TenantContext;
    const factory = {
      create: vi.fn().mockResolvedValue(context),
    } as unknown as TenantContextFactory;
    const connector = {
      create_folder: vi.fn().mockResolvedValue('folder-id'),
      upload_small_file: vi.fn().mockResolvedValue(undefined),
      upload_large_file: vi.fn().mockResolvedValue(undefined),
    } as unknown as SharePointSiteConnector;
    const manifests = {
      find_by_snapshot: vi.fn().mockResolvedValue({
        snapshot_id: 'snap-1',
        site_id: 'site-1',
        created_at: new Date('2026-08-17T00:00:00.000Z'),
        total_files: 2,
        entries: [make_entry('f1'), make_entry('f2')],
      }),
    } as unknown as SharePointManifestRepository;
    const service = new SharePointRestoreService(factory, connector, manifests);
    const on_progress = vi.fn((event: { phase: string; processed: number }) => {
      if (event.phase === 'processing' && event.processed === 1) interrupted = true;
    });

    const result = await service.restore_sharepoint('tenant-1', 'site-1', {
      snapshot_id: 'snap-1',
      on_progress,
      should_interrupt: () => interrupted,
    });

    expect(result).toMatchObject({ files_restored: 1, files_skipped: 0, interrupted: true });
    expect(connector.upload_small_file).toHaveBeenCalledTimes(1);
    expect(on_progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'interrupted' }));
  });
});
