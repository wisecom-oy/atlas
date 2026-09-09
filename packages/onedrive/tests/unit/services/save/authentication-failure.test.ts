import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { OneDriveSaveService } from '@/services/save/save.service';
import {
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type {
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';

/**
 * Issue #341: a file whose decryption failed was mapped to `undefined` and counted as a skip, so a
 * three file export finished as a valid ZIP with `files_saved: 2`, `files_skipped: 1`, no errors
 * and no integrity failures. Nothing in the result said a file had failed to authenticate.
 */

vi.mock('@wisecom/atlas-core/services/shared/file-save-zip-writer', async (import_original) => {
  const actual =
    await import_original<
      typeof import('@wisecom/atlas-core/services/shared/file-save-zip-writer')
    >();
  const archive = {
    append: vi.fn(),
    finalize: vi.fn().mockResolvedValue(undefined),
    pointer: vi.fn().mockReturnValue(4096),
  };
  return {
    ...actual,
    create_file_archive: vi.fn().mockReturnValue({
      archive,
      promise: Promise.resolve(4096),
      publish: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    }),
    add_file_to_archive: vi.fn().mockResolvedValue(undefined),
    finalize_file_archive: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('@wisecom/atlas-drive/restore/streaming-restore', () => ({
  should_stream_restore: vi.fn().mockReturnValue(false),
  stream_decrypt_from_storage: vi.fn(),
  verify_streaming_checksum: vi.fn().mockReturnValue(true),
}));
vi.mock('@wisecom/atlas-core/utils/zone-identifier', () => ({
  mark_downloaded_from_internet: vi.fn().mockResolvedValue(undefined),
}));

const CORRUPT_KEY = 'onedrive/data/owner-1/corrupt';
/** The plaintext the stub decrypts to for every healthy object, and the checksum of it. */
const HEALTHY_CONTENT = 'ciphertext';
const HEALTHY_CHECKSUM = createHash('sha256').update(HEALTHY_CONTENT).digest('hex');

function make_entry(file_id: string, storage_key: string): OneDriveManifestEntry {
  return {
    file_id,
    drive_id: 'drive-1',
    file_name: `${file_id}.docx`,
    parent_path: '/Documents',
    size_bytes: 2048,
    change_type: 'updated',
    backup_at: '2026-03-15T10:00:00.000Z',
    storage_key,
    checksum: HEALTHY_CHECKSUM,
  } as OneDriveManifestEntry;
}

/** Builds a save service whose storage serves one corrupt object and healthy bytes for the rest. */
function make_service(entries: OneDriveManifestEntry[]): OneDriveSaveService {
  const ctx = {
    storage: {
      get: vi.fn(async (key: string) =>
        Buffer.from(key === CORRUPT_KEY ? 'corrupt' : HEALTHY_CONTENT),
      ),
      put: vi.fn(),
      exists: vi.fn(),
      delete: vi.fn(),
    },
    // The GCM failure shape: the tag does not verify, so decrypt throws for that object only.
    decrypt: vi.fn((buf: Buffer) => {
      if (buf.toString() === 'corrupt') {
        throw new Error('Unsupported state or unable to authenticate data');
      }
      return buf;
    }),
    encrypt: vi.fn((buf: Buffer) => buf),
    destroy: vi.fn(),
  } as unknown as TenantContext;

  const manifest: OneDriveSnapshotManifest = {
    id: 'manifest-od-1',
    tenant_id: 'tenant-1',
    snapshot_id: 'od-snap-1',
    owner_id: 'owner-1',
    created_at: new Date('2026-03-15T10:00:00Z'),
    total_files: entries.length,
    total_size_bytes: entries.reduce((sum, e) => sum + e.size_bytes, 0),
    entries,
  };

  const container = new Container();
  container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue({
    create: vi.fn().mockResolvedValue(ctx),
    create_readonly: vi.fn().mockResolvedValue(ctx),
    create_storage_only: vi.fn().mockResolvedValue(ctx),
  } as unknown as TenantContextFactory);
  container.bind(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN).toConstantValue({
    find_by_snapshot: vi.fn().mockResolvedValue(manifest),
    list_snapshots_by_owner: vi.fn().mockResolvedValue([manifest]),
  } as unknown as OneDriveManifestRepository);
  container.bind(OneDriveSaveService).toSelf();
  return container.get(OneDriveSaveService);
}

describe('OneDrive save with one object that fails to authenticate (issue #341)', () => {
  let service: OneDriveSaveService;

  beforeEach(() => {
    service = make_service([
      make_entry('file-1', 'onedrive/data/owner-1/one'),
      make_entry('file-2', CORRUPT_KEY),
      make_entry('file-3', 'onedrive/data/owner-1/three'),
    ]);
  });

  it('reports the failure instead of finishing a clean two-of-three export', async () => {
    const result = await service.save_snapshot('tenant-1', 'owner-1', {
      snapshot_id: 'od-snap-1',
      output_path: '/tmp/save.zip',
    });

    expect(result.files_saved).toBe(2);
    expect(result.files_skipped).toBe(1);
    // Both, and they say different things: the error names what happened, the integrity failure
    // says this file is not in the archive because it could not be authenticated.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('file-2.docx');
    expect(result.integrity_failures).toEqual(['file-2']);
  });

  // The same rule verification and restore apply: an entry nobody can check is not a pass. The
  // streaming export path already refused one; the buffered path wrote it into the archive.
  it('refuses an entry that records no checksum rather than archiving it unchecked', async () => {
    const unverifiable = make_entry('file-2', 'onedrive/data/owner-1/two');
    delete (unverifiable as { checksum?: string }).checksum;
    service = make_service([make_entry('file-1', 'onedrive/data/owner-1/one'), unverifiable]);

    const result = await service.save_snapshot('tenant-1', 'owner-1', {
      snapshot_id: 'od-snap-1',
      output_path: '/tmp/save.zip',
    });

    expect(result.files_saved).toBe(1);
    expect(result.integrity_failures).toEqual(['file-2']);
  });
});
