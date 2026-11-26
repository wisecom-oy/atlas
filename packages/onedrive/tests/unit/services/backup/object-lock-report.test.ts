import { describe, expect, it, vi } from 'vitest';
import type {
  ObjectLockRequest,
  OneDriveDeltaItem,
  OneDriveSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { latest_readable, readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';
import { list_one_drive_snapshot } from '@wisecom/atlas-types/testing/stub-drive-snapshot-listing';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { OneDriveBackupService } from '@/services/backup/backup.service';

// Issue #975: a OneDrive run records the Object Lock policy it stamped on its objects, on the
// manifest it writes and on the result it returns, the way an Outlook run does.

const DRIVE_ID = 'd1';
const DAY_MS = 86_400_000;

function make_item(item_id: string): OneDriveDeltaItem {
  return {
    item_id,
    drive_id: DRIVE_ID,
    kind: 'file',
    file_name: `${item_id}.txt`,
    parent_path: '/',
    size_bytes: 8,
    deleted: false,
    etag: `etag-${item_id}`,
    last_modified_at: '2026-08-01T00:00:00Z',
  };
}

function make_harness(items: OneDriveDeltaItem[]) {
  const connector = {
    list_drives: vi.fn().mockResolvedValue([{ drive_id: DRIVE_ID, drive_name: 'Documents' }]),
    fetch_delta: vi.fn().mockResolvedValue({
      drive_id: DRIVE_ID,
      delta_link: 'delta-1',
      items,
      reset_detected: false,
    }),
    fetch_item_by_id: vi.fn(),
    download_file_content: vi.fn((item: OneDriveDeltaItem) =>
      Promise.resolve(Buffer.from(item.item_id)),
    ),
    list_file_versions: vi.fn().mockResolvedValue([]),
  };
  const context = {
    tenant_id: 't',
    storage: {
      exists: vi.fn().mockResolvedValue(false),
      put: vi.fn().mockResolvedValue(undefined),
      list: vi.fn(list_one_drive_snapshot()),
      delete: vi.fn().mockResolvedValue(undefined),
      list_stale: vi.fn(async () => []),
      abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
      validate_object_lock_policy: vi.fn().mockResolvedValue(undefined),
    },
    encrypt: (buffer: Buffer) => buffer,
    destroy: vi.fn(),
    create_content_hmac: stub_tenant_create_content_hmac,
  } as unknown as TenantContext;
  const factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(context),
    create_readonly: vi.fn().mockResolvedValue(context),
    create_storage_only: vi.fn(),
  };
  const saved: OneDriveSnapshotManifest[] = [];
  const manifests = {
    find_latest_readable: vi.fn().mockResolvedValue(latest_readable()),
    list_readable_snapshots_by_owner: vi.fn().mockResolvedValue(readable_manifests([])),
    save: vi.fn(async (_ctx: TenantContext, manifest: OneDriveSnapshotManifest) => {
      saved.push(manifest);
    }),
  };
  const service = new OneDriveBackupService(
    factory,
    connector as never,
    manifests as never,
    {
      load_version_watermarks: vi.fn().mockResolvedValue({}),
      write_run_index: vi.fn(),
    } as never,
    { load: vi.fn(), save: vi.fn() } as never,
    stub_owner_leases().leases,
  );
  return { service, saved };
}

function backup(items: OneDriveDeltaItem[], request?: ObjectLockRequest) {
  const harness = make_harness(items);
  const options = request ? { object_lock_request: request } : {};
  return harness.service.backup_onedrive('t', 'owner-1', options).then((result) => ({
    result,
    saved: harness.saved,
  }));
}

function days_until(instant: string | undefined): number {
  return (Date.parse(instant ?? '') - Date.now()) / DAY_MS;
}

describe('OneDrive backup Object Lock report (#975)', () => {
  it('records the requested and the applied policy on the manifest it writes', async () => {
    const { saved } = await backup([make_item('f1')], { mode: 'COMPLIANCE', retention_days: 30 });

    const object_lock = saved[0]?.object_lock;
    expect(object_lock?.requested).toEqual({ mode: 'COMPLIANCE', retention_days: 30 });
    expect(object_lock?.effective.mode).toBe('COMPLIANCE');
    expect(days_until(object_lock?.effective.retain_until)).toBeGreaterThan(29.9);
    expect(days_until(object_lock?.effective.retain_until)).toBeLessThanOrEqual(30);
  });

  it('returns the same policy on the result and on its snapshot', async () => {
    const { result, saved } = await backup([make_item('f1')], { retention_days: 7 });

    expect(result.object_lock).toEqual(saved[0]?.object_lock);
    expect(result.snapshot?.object_lock).toEqual(saved[0]?.object_lock);
  });

  it('records the default GOVERNANCE mode as applied when the request names none', async () => {
    const { result } = await backup([make_item('f1')], { retention_days: 7 });

    expect(result.object_lock?.requested).toEqual({ mode: undefined, retention_days: 7 });
    expect(result.object_lock?.effective.mode).toBe('GOVERNANCE');
  });

  it('writes no policy without a lock request', async () => {
    const { result, saved } = await backup([make_item('f1')]);

    expect(saved[0]).not.toHaveProperty('object_lock');
    expect(result).not.toHaveProperty('object_lock');
  });

  it('reports the policy on a run that created no snapshot', async () => {
    const { result, saved } = await backup([], { mode: 'GOVERNANCE', retention_days: 7 });

    expect(saved).toEqual([]);
    expect(result.snapshot).toBeUndefined();
    expect(result.object_lock?.effective.mode).toBe('GOVERNANCE');
  });
});
