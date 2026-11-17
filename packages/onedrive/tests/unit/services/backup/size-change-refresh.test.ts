import { describe, it, expect, vi } from 'vitest';
import type { OneDriveConnector, OneDriveDeltaItem, TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { assert_transferred_size } from '@wisecom/atlas-drive/backup/download-integrity';
import {
  process_delta_item,
  type DriveTrackingState,
} from '@/services/backup/delta-item-processor';

// Issue #759: OneDrive gets the same refresh as SharePoint. The entry must record the stored size.

const LISTED = 145_408;
const SERVED = 151_040;

function make_item(): OneDriveDeltaItem {
  return {
    item_id: 'item-1',
    drive_id: 'drive-1',
    kind: 'file',
    file_name: 'Message.msg',
    parent_path: '/',
    size_bytes: LISTED,
    deleted: false,
    etag: 'etag-1',
    download_url: 'https://cdn.example.invalid/listed',
  };
}

describe('OneDrive file that grows on its first download (issue #759)', () => {
  it('records the stored size in the manifest entry and reports no error', async () => {
    const connector = {
      download_file_content: vi.fn(async (item: OneDriveDeltaItem) => {
        const body = Buffer.alloc(SERVED, 'x');
        assert_transferred_size(item.item_id, body.length, item.size_bytes);
        return body;
      }),
      fetch_item_by_id: vi.fn(async () => ({
        ...make_item(),
        size_bytes: SERVED,
        download_url: 'https://cdn.example.invalid/fresh',
      })),
      list_file_versions: vi.fn(async () => []),
      resolve_download_url: vi.fn(async () => undefined),
    } as unknown as OneDriveConnector;
    const ctx = {
      tenant_id: 'tenant-1',
      storage: { exists: vi.fn(async () => false), put: vi.fn(async () => undefined) },
      encrypt: (buffer: Buffer) => buffer,
      create_content_hmac: stub_tenant_create_content_hmac,
    } as unknown as TenantContext;
    const state: DriveTrackingState = {
      previous_path_by_file_id: {},
      previous_name_by_file_id: {},
      previous_etag_by_file_id: {},
      previous_kind_by_file_id: {},
    };

    const outcome = await process_delta_item(
      connector,
      make_item(),
      'owner-1',
      'snap-1',
      ctx,
      state,
      { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
      () => {},
      { watermarks: {}, rows: new Map() } as never,
    );

    expect(connector.fetch_item_by_id).toHaveBeenCalledWith(
      'tenant-1',
      'owner-1',
      'drive-1',
      'item-1',
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.entry?.size_bytes).toBe(SERVED);
    expect(outcome.files_stored).toBe(1);
  });
});
