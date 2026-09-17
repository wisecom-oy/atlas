/**
 * Issue #405, reported against SharePoint and true of the OneDrive twin for the same reason: an
 * owner with nothing in their drive and an owner already covered by a snapshot returned an
 * identical empty result, so a consumer reported both as backed up while only one had a recovery
 * point. Both workloads carry the same `no_snapshot_reason`, because a field on one and not the
 * other is how the SDK ended up with two vocabularies before v5.0.0.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  OneDriveDeltaCursor,
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveBackupService } from '@/services/backup/backup.service';

const OWNER_ID = 'owner-1';

/** A cursor from an earlier run that knows the drive holds one file. */
function cursor_knowing_a_file(): OneDriveDeltaCursor {
  return {
    owner_id: OWNER_ID,
    delta_link_by_drive: { 'drive-1': 'delta-drive-1' },
    previous_path_by_file_id: { f1: '/Report.docx' },
    previous_name_by_file_id: { f1: 'Report.docx' },
    previous_etag_by_file_id: { f1: 'etag-1' },
    previous_kind_by_file_id: { f1: 'file' },
    updated_at: new Date().toISOString(),
  } as OneDriveDeltaCursor;
}

/** A backup service whose drive list, cursor and manifest repository the case controls. */
function make_service(options: {
  drives?: { drive_id: string; drive_name: string }[];
  previous_cursor?: OneDriveDeltaCursor;
  manifests?: OneDriveManifestRepository;
}): { service: OneDriveBackupService; manifests: OneDriveManifestRepository } {
  const connector = {
    list_drives: vi.fn().mockResolvedValue(options.drives ?? []),
    fetch_delta: vi.fn().mockResolvedValue({
      drive_id: 'drive-1',
      delta_link: 'delta-drive-1',
      items: [],
      reset_detected: false,
    }),
    fetch_item_by_id: vi.fn(),
    download_file_content: vi.fn(),
    list_file_versions: vi.fn().mockResolvedValue([]),
  };

  const context = {
    tenant_id: 't',
    storage: {
      exists: vi.fn().mockResolvedValue(false),
      put: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      list_stale: vi.fn(async () => []),
      abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
    },
    encrypt: (buffer: Buffer) => buffer,
    destroy: vi.fn(),
  } as unknown as TenantContext;

  const factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(context),
    create_readonly: vi.fn().mockResolvedValue(context),
    create_storage_only: vi.fn(),
  };

  const manifests =
    options.manifests ??
    ({
      save: vi.fn().mockResolvedValue(undefined),
      find_latest_by_owner: vi.fn().mockResolvedValue(undefined),
    } as unknown as OneDriveManifestRepository);

  const service = new OneDriveBackupService(
    factory,
    connector as never,
    manifests as never,
    {
      load_version_watermarks: vi.fn().mockResolvedValue({}),
      write_run_index: vi.fn().mockResolvedValue(undefined),
    } as never,
    {
      load: vi.fn().mockResolvedValue(options.previous_cursor),
      save: vi.fn().mockResolvedValue(undefined),
    } as never,
  );

  return { service, manifests };
}

describe('OneDrive backup with no snapshot to create (issue #405)', () => {
  it('reports no_content when the owner has no drive content and no snapshot', async () => {
    const { service } = make_service({});

    const result = await service.backup_onedrive('tenant-1', OWNER_ID, {});

    expect(result.snapshot).toBeUndefined();
    expect(result.summary.snapshot_created).toBe(false);
    expect(result.summary.no_snapshot_reason).toBe('no_content');
  });

  it('reports no_changes when the cursor already knows a file', async () => {
    const { service, manifests } = make_service({
      drives: [{ drive_id: 'drive-1', drive_name: 'OneDrive' }],
      previous_cursor: cursor_knowing_a_file(),
    });

    const result = await service.backup_onedrive('tenant-1', OWNER_ID, {});

    expect(result.summary.no_snapshot_reason).toBe('no_changes');
    // The cursor already answered the question, so the run spends no extra storage read.
    expect(manifests.find_latest_by_owner).not.toHaveBeenCalled();
  });

  it('reports no_changes for an empty-looking run that has a snapshot in storage', async () => {
    const manifests = {
      save: vi.fn().mockResolvedValue(undefined),
      find_latest_by_owner: vi
        .fn()
        .mockResolvedValue({ snapshot_id: 'od-snap-1' } as OneDriveSnapshotManifest),
    } as unknown as OneDriveManifestRepository;

    const { service } = make_service({ manifests });

    const result = await service.backup_onedrive('tenant-1', OWNER_ID, {});

    expect(result.summary.no_snapshot_reason).toBe('no_changes');
  });
});
