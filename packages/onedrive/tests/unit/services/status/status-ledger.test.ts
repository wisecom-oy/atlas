import { describe, expect, it, vi } from 'vitest';
import { AuthError } from '@wisecom/atlas-types';
import type {
  OneDriveConnector,
  OneDriveDeltaCursorRepository,
  OneDriveManifestRepository,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveStatusService } from '@/services/status/status.service';
import { latest_readable } from '@wisecom/atlas-types/testing/readable-listing';
import { list_one_drive_snapshot } from '@wisecom/atlas-types/testing/stub-drive-snapshot-listing';

const TENANT_ID = 'tenant-1';
const OWNER_ID = '00000000-0000-0000-0000-000000000001';

const FAILED = {
  item_id: 'file-9',
  drive_id: 'drive-1',
  name: 'report.docx',
  reason: 'HTTP 503',
  attempts: 5,
  first_failed_at: '2026-01-01T00:00:00.000Z',
  last_failed_at: '2026-01-01T00:00:00.000Z',
};

function build(fetch_delta: OneDriveConnector['fetch_delta']): OneDriveStatusService {
  // One stored snapshot, so the saved cursor is still resumable (issue #725).
  const ctx = {
    storage: { list: list_one_drive_snapshot() },
    destroy: vi.fn(),
  } as unknown as TenantContext;
  const factory = { create_readonly: vi.fn().mockResolvedValue(ctx) };
  const connector = {
    list_drives: vi.fn().mockResolvedValue([{ drive_id: 'drive-1', drive_name: 'OneDrive' }]),
    fetch_delta,
  };
  const cursors = {
    load: vi.fn().mockResolvedValue({
      owner_id: OWNER_ID,
      delta_link_by_drive: { 'drive-1': 'https://graph.example/delta?token=1' },
      previous_kind_by_file_id: {},
      failed_items: { [FAILED.item_id]: FAILED },
    }),
  };
  const manifests = { find_latest_readable: vi.fn().mockResolvedValue(latest_readable(undefined)) };
  return new OneDriveStatusService(
    factory as unknown as TenantContextFactory,
    connector as unknown as OneDriveConnector,
    manifests as unknown as OneDriveManifestRepository,
    cursors as unknown as OneDriveDeltaCursorRepository,
  );
}

describe('OneDriveStatusService ledger and errors (issue #630)', () => {
  it('counts a permanently skipped file against up-to-date, since it is missing from the backup', async () => {
    const service = build(vi.fn().mockResolvedValue({ items: [], delta_link: 'next' }));

    const result = await service.check_onedrive_status(TENANT_ID, OWNER_ID);

    expect(result.total_failed_items).toBe(1);
    expect(result.drives[0]).toMatchObject({ failed_items: 1, is_up_to_date: false });
    expect(result.is_up_to_date).toBe(false);
  });

  it('does not count the folders a file change touches', async () => {
    const service = build(
      vi.fn().mockResolvedValue({
        items: [
          { item_id: 'root', kind: 'folder', deleted: false },
          { item_id: 'parent', kind: 'folder', deleted: false },
          { item_id: 'a', kind: 'file', deleted: false },
          { item_id: 'b', kind: 'file', deleted: false },
          { item_id: 'c', kind: 'file', deleted: false },
        ],
        delta_link: 'next',
      }),
    );

    const result = await service.check_onedrive_status(TENANT_ID, OWNER_ID);

    expect(result.total_pending_changes).toBe(3);
  });

  it('rejects with AuthError on an unclassified Graph 401', async () => {
    const graph_401 = Object.assign(new Error('InvalidAuthenticationToken'), { statusCode: 401 });
    const service = build(vi.fn().mockRejectedValue(graph_401));

    await expect(service.check_onedrive_status(TENANT_ID, OWNER_ID)).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});
