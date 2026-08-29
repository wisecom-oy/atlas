import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { SharePointRestoreService } from '@/services/sharepoint-restore.service';
import {
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type {
  SharePointManifestEntry,
  SharePointManifestRepository,
  SharePointSiteConnector,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';

vi.mock('@/services/sharepoint-restore-streaming', () => ({
  should_stream_restore: vi.fn().mockReturnValue(false),
  stream_decrypt_from_storage: vi.fn(),
  verify_streaming_checksum: vi.fn().mockReturnValue(true),
}));

const CONTENT = Buffer.from('restored-file-content');
const SOURCE_SITE = 'source-site';
const SOURCE_DRIVE = 'source-drive';
const TARGET_SITE = 'target-site';

function make_entry(overrides: Partial<SharePointManifestEntry> = {}): SharePointManifestEntry {
  return {
    file_id: 'sp-file-1',
    drive_id: SOURCE_DRIVE,
    library_name: 'Tiedostot',
    file_name: 'report.docx',
    parent_path: '/Reports',
    size_bytes: CONTENT.length,
    change_type: 'created',
    backup_at: '2026-03-15T10:00:00.000Z',
    storage_key: 'sharepoint/data/source-site/abc',
    checksum: createHash('sha256').update(CONTENT).digest('hex'),
    ...overrides,
  };
}

describe('SharePointRestoreService cross-site routing', () => {
  let container: Container;
  let connector: SharePointSiteConnector;
  let manifests: SharePointManifestRepository;
  let service: SharePointRestoreService;

  beforeEach(() => {
    container = new Container();

    const ctx = {
      storage: { get: vi.fn().mockResolvedValue(CONTENT) },
      decrypt: vi.fn((buf: Buffer) => buf),
      destroy: vi.fn(),
    } as unknown as TenantContext;

    const factory: TenantContextFactory = {
      create: vi.fn().mockResolvedValue(ctx),
      create_readonly: vi.fn().mockResolvedValue(ctx),
      create_storage_only: vi.fn(),
    };

    connector = {
      list_document_libraries: vi.fn().mockResolvedValue([]),
      create_folder: vi.fn().mockResolvedValue('folder-id'),
      upload_small_file: vi.fn().mockResolvedValue(undefined),
      upload_large_file: vi.fn().mockResolvedValue(undefined),
    } as unknown as SharePointSiteConnector;

    manifests = {
      find_by_snapshot: vi.fn().mockResolvedValue({
        snapshot_id: 'sp-snap-1',
        site_id: SOURCE_SITE,
        created_at: new Date('2026-03-15T10:00:00Z'),
        total_files: 1,
        entries: [make_entry()],
      }),
      list_snapshots_by_site: vi.fn().mockResolvedValue([]),
    } as unknown as SharePointManifestRepository;

    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(factory);
    container.bind(SHAREPOINT_CONNECTOR_TOKEN).toConstantValue(connector);
    container.bind(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN).toConstantValue(manifests);
    container.bind(SharePointRestoreService).toSelf();

    service = container.get(SharePointRestoreService);
  });

  it('uploads into the target site library, never the source drive', async () => {
    vi.mocked(connector.list_document_libraries).mockResolvedValue([
      { drive_id: 'target-drive', drive_name: 'Documents' },
    ]);

    const result = await service.restore_sharepoint('tenant', SOURCE_SITE, {
      snapshot_id: 'sp-snap-1',
      target_site_id: TARGET_SITE,
    });

    expect(result.files_restored).toBe(1);
    expect(connector.upload_small_file).toHaveBeenCalledWith(
      'tenant',
      TARGET_SITE,
      'target-drive',
      expect.any(String),
      'report.docx',
      CONTENT,
      'rename',
      undefined,
    );
    // The source library must not be touched, by site or by drive.
    const [, site_arg, drive_arg] = vi.mocked(connector.upload_small_file).mock.calls[0]!;
    expect(site_arg).not.toBe(SOURCE_SITE);
    expect(drive_arg).not.toBe(SOURCE_DRIVE);
  });

  it('recreates the folder path beneath the restore root in the target drive', async () => {
    vi.mocked(connector.list_document_libraries).mockResolvedValue([
      { drive_id: 'target-drive', drive_name: 'Documents' },
    ]);

    await service.restore_sharepoint('tenant', SOURCE_SITE, {
      snapshot_id: 'sp-snap-1',
      target_site_id: TARGET_SITE,
    });

    const [root_call, nested_call] = vi.mocked(connector.create_folder).mock.calls;
    expect(root_call).toEqual([
      'tenant',
      TARGET_SITE,
      'target-drive',
      'root',
      expect.stringMatching(/^Restore-\d{4}-\d{2}-\d{2}T/),
    ]);
    // The original nesting is recreated under that root, never at the drive root.
    expect(nested_call).toEqual(['tenant', TARGET_SITE, 'target-drive', 'folder-id', 'Reports']);
  });

  it('routes by library name when the target has several libraries', async () => {
    vi.mocked(connector.list_document_libraries).mockResolvedValue([
      { drive_id: 'target-archive', drive_name: 'Archive' },
      { drive_id: 'target-tiedostot', drive_name: 'Tiedostot' },
    ]);

    await service.restore_sharepoint('tenant', SOURCE_SITE, {
      snapshot_id: 'sp-snap-1',
      target_site_id: TARGET_SITE,
    });

    expect(vi.mocked(connector.upload_small_file).mock.calls[0]![2]).toBe('target-tiedostot');
  });

  it('reports an error instead of guessing when no target library matches', async () => {
    vi.mocked(connector.list_document_libraries).mockResolvedValue([
      { drive_id: 'target-docs', drive_name: 'Documents' },
      { drive_id: 'target-archive', drive_name: 'Archive' },
    ]);

    const result = await service.restore_sharepoint('tenant', SOURCE_SITE, {
      snapshot_id: 'sp-snap-1',
      target_site_id: TARGET_SITE,
    });

    expect(connector.upload_small_file).not.toHaveBeenCalled();
    expect(result.files_restored).toBe(0);
    expect(result.files_skipped).toBe(1);
    // A non-empty errors array is what drives the CLI's non-zero exit.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Tiedostot');
  });

  it('reports an unresolvable library once, not once per skipped file', async () => {
    vi.mocked(connector.list_document_libraries).mockResolvedValue([
      { drive_id: 'target-docs', drive_name: 'Documents' },
      { drive_id: 'target-archive', drive_name: 'Archive' },
    ]);
    vi.mocked(manifests.find_by_snapshot).mockResolvedValue({
      snapshot_id: 'sp-snap-1',
      site_id: SOURCE_SITE,
      created_at: new Date('2026-03-15T10:00:00Z'),
      total_files: 3,
      entries: [
        make_entry({ file_id: 'a', file_name: 'a.docx' }),
        make_entry({ file_id: 'b', file_name: 'b.docx' }),
        make_entry({ file_id: 'c', file_name: 'c.docx' }),
      ],
    } as never);

    const result = await service.restore_sharepoint('tenant', SOURCE_SITE, {
      snapshot_id: 'sp-snap-1',
      target_site_id: TARGET_SITE,
    });

    // Every file is still counted, but the operator reads one explanation.
    expect(result.files_skipped).toBe(3);
    expect(result.errors).toHaveLength(1);
  });

  it('fails the run when the target site has no document libraries', async () => {
    vi.mocked(connector.list_document_libraries).mockResolvedValue([]);

    await expect(
      service.restore_sharepoint('tenant', SOURCE_SITE, {
        snapshot_id: 'sp-snap-1',
        target_site_id: TARGET_SITE,
      }),
    ).rejects.toThrow(/no document libraries/i);

    expect(connector.upload_small_file).not.toHaveBeenCalled();
  });

  it("refuses to fold several source libraries into the target's only library", async () => {
    vi.mocked(connector.list_document_libraries).mockResolvedValue([
      { drive_id: 'target-docs', drive_name: 'Documents' },
    ]);
    vi.mocked(manifests.find_by_snapshot).mockResolvedValue({
      snapshot_id: 'sp-snap-1',
      site_id: SOURCE_SITE,
      created_at: new Date('2026-03-15T10:00:00Z'),
      total_files: 2,
      // Same drive-relative path in two libraries: merging them would make the
      // second file overwrite the first under --conflict replace.
      entries: [
        make_entry({ file_id: 'a', drive_id: 'source-docs', library_name: 'Documents' }),
        make_entry({ file_id: 'b', drive_id: 'source-policies', library_name: 'Policies' }),
      ],
    } as never);

    const result = await service.restore_sharepoint('tenant', SOURCE_SITE, {
      snapshot_id: 'sp-snap-1',
      target_site_id: TARGET_SITE,
      conflict_behavior: 'replace',
    });

    // "Documents" still matches by name; "Policies" has nowhere to go and is refused.
    expect(vi.mocked(connector.upload_small_file).mock.calls.map((c) => c[2])).toEqual([
      'target-docs',
    ]);
    expect(result.files_skipped).toBe(1);
    expect(result.errors.join(' ')).toContain('Policies');
  });

  it('reports an error when a file fails verification, so the run cannot exit 0', async () => {
    vi.mocked(connector.list_document_libraries).mockResolvedValue([
      { drive_id: 'target-drive', drive_name: 'Documents' },
    ]);
    vi.mocked(manifests.find_by_snapshot).mockResolvedValue({
      snapshot_id: 'sp-snap-1',
      site_id: SOURCE_SITE,
      created_at: new Date('2026-03-15T10:00:00Z'),
      total_files: 1,
      entries: [make_entry({ checksum: 'a'.repeat(64) })],
    } as never);

    const result = await service.restore_sharepoint('tenant', SOURCE_SITE, {
      snapshot_id: 'sp-snap-1',
      target_site_id: TARGET_SITE,
    });

    expect(connector.upload_small_file).not.toHaveBeenCalled();
    expect(result.files_restored).toBe(0);
    expect(result.errors).toHaveLength(1);
  });

  it('restores in place using the recorded drive when no target site is given', async () => {
    const result = await service.restore_sharepoint('tenant', SOURCE_SITE, {
      snapshot_id: 'sp-snap-1',
    });

    expect(result.files_restored).toBe(1);
    expect(connector.upload_small_file).toHaveBeenCalledWith(
      'tenant',
      SOURCE_SITE,
      SOURCE_DRIVE,
      expect.any(String),
      'report.docx',
      CONTENT,
      'rename',
      undefined,
    );
    // Same-site restore must not pay for a library lookup it cannot use.
    expect(connector.list_document_libraries).not.toHaveBeenCalled();
  });

  it('treats an explicit target equal to the source as an in-place restore', async () => {
    const result = await service.restore_sharepoint('tenant', SOURCE_SITE, {
      snapshot_id: 'sp-snap-1',
      target_site_id: SOURCE_SITE,
    });

    expect(result.files_restored).toBe(1);
    expect(vi.mocked(connector.upload_small_file).mock.calls[0]![2]).toBe(SOURCE_DRIVE);
  });
});
