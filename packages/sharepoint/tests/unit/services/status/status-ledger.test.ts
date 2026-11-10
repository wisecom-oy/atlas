import { describe, expect, it, vi } from 'vitest';
import { AuthError } from '@wisecom/atlas-types';
import type {
  SharePointDeltaCursorRepository,
  SharePointManifestRepository,
  SharePointSiteConnector,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { SharePointStatusService } from '@/services/status/status.service';

const TENANT_ID = 'tenant-1';
const SITE_ID =
  'contoso.sharepoint.com,00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000002';

const FAILED = {
  item_id: 'file-9',
  drive_id: 'library-1',
  name: 'report.docx',
  reason: 'HTTP 503',
  attempts: 1,
  first_failed_at: '2026-01-01T00:00:00.000Z',
  last_failed_at: '2026-01-01T00:00:00.000Z',
};

function build(fetch_delta: SharePointSiteConnector['fetch_delta']): SharePointStatusService {
  const ctx = { storage: {}, destroy: vi.fn() } as unknown as TenantContext;
  const factory = { create_readonly: vi.fn().mockResolvedValue(ctx) };
  const connector = {
    list_document_libraries: vi
      .fn()
      .mockResolvedValue([{ drive_id: 'library-1', drive_name: 'Documents' }]),
    fetch_delta,
  };
  const cursors = {
    load: vi.fn().mockResolvedValue({
      site_id: SITE_ID,
      delta_link_by_drive: { 'library-1': 'https://graph.example/delta?token=1' },
      previous_kind_by_file_id: { 'old-folder': 'folder' },
      failed_items: { [FAILED.item_id]: FAILED },
    }),
  };
  const manifests = { find_latest_by_site: vi.fn().mockResolvedValue(undefined) };
  return new SharePointStatusService(
    factory as unknown as TenantContextFactory,
    connector as unknown as SharePointSiteConnector,
    manifests as unknown as SharePointManifestRepository,
    cursors as unknown as SharePointDeltaCursorRepository,
  );
}

describe('SharePointStatusService ledger and errors (issue #630)', () => {
  it('is not up to date while the failed-item ledger holds a file, even with no delta changes', async () => {
    const service = build(vi.fn().mockResolvedValue({ items: [], delta_link: 'next' }));

    const result = await service.check_sharepoint_status(TENANT_ID, SITE_ID);

    expect(result.total_failed_items).toBe(1);
    expect(result.libraries[0]).toMatchObject({ failed_items: 1, is_up_to_date: false });
    expect(result.is_up_to_date).toBe(false);
  });

  it('uses the cursor kind map, so a deleted folder is not counted as a pending file', async () => {
    const service = build(
      vi.fn().mockResolvedValue({
        items: [
          { item_id: 'root', kind: 'folder', deleted: false },
          { item_id: 'old-folder', kind: 'file', deleted: true },
          { item_id: 'new-file', kind: 'file', deleted: false },
        ],
        delta_link: 'next',
      }),
    );

    const result = await service.check_sharepoint_status(TENANT_ID, SITE_ID);

    expect(result.total_pending_changes).toBe(1);
  });

  it('rejects with AuthError when Graph refuses the delta peek', async () => {
    const service = build(vi.fn().mockRejectedValue(new AuthError('403 Forbidden')));

    await expect(service.check_sharepoint_status(TENANT_ID, SITE_ID)).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});
