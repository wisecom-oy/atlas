import { describe, expect, it, vi } from 'vitest';
import type {
  DriveFolderColor,
  SharePointBackupOptions,
  SharePointDeltaItem,
  SharePointSiteConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import { stub_folder_color_reader } from '@wisecom/atlas-types/testing/stub-folder-color-reader';
import { process_single_library } from '@/services/backup/backup-library-processor';
import { build_tracking_state } from '@/services/backup/file-tracking-state';
import type { FileTrackingState } from '@/services/backup/library-item-processor';

const BLUE: DriveFolderColor = { color_hex: '6' };

function folder(item_id: string, fields: Partial<SharePointDeltaItem> = {}): SharePointDeltaItem {
  return {
    item_id,
    drive_id: 'lib-1',
    kind: 'folder',
    file_name: item_id,
    parent_path: '/',
    size_bytes: 0,
    deleted: false,
    ...fields,
  };
}

const DELTA = [folder('root', { is_root: true }), folder('Coloured'), folder('Plain')];

async function back_up_library(tracking: FileTrackingState) {
  const reader = stub_folder_color_reader({ Coloured: BLUE });
  const connector = {
    fetch_delta: vi.fn(async () => ({
      drive_id: 'lib-1',
      items: DELTA,
      delta_link: 'next-link',
      reset_detected: false,
    })),
    fetch_item_permissions: vi.fn(async () => new Map()),
    ...reader.connector,
  } as unknown as SharePointSiteConnector;
  const result = await process_single_library(
    connector,
    { watermarks: {}, pending: {}, rows: new Map() },
    'tenant-1',
    'site-1',
    'sp-snap-test',
    { drive_id: 'lib-1', drive_name: 'Documents' },
    {} as SharePointBackupOptions,
    undefined,
    tracking,
    {},
    {} as TenantContext,
    { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
    {},
  );
  return { result, reader };
}

describe('SharePoint backup of folder colours (#581)', () => {
  it('reads the library folders in one batched call and records the coloured one', async () => {
    const tracking = build_tracking_state(undefined);

    const { result, reader } = await back_up_library(tracking);

    expect(reader.calls).toEqual([['Coloured', 'Plain']]);
    expect(result.entries).toEqual([
      expect.objectContaining({
        file_id: 'Coloured',
        kind: 'folder',
        library_name: 'Documents',
        folder_color: BLUE,
      }),
    ]);
    expect(tracking.folder_color_by_item_id).toEqual({ Coloured: BLUE });
  });

  it('writes nothing when the next run sees the same colour', async () => {
    const tracking = build_tracking_state(undefined);
    await back_up_library(tracking);

    const { result } = await back_up_library(tracking);

    expect(result.entries).toEqual([]);
  });
});
