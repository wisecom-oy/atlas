/**
 * Issue #53: a malware-quarantined file must not stall the backup.
 *
 * Graph never serves quarantined content, and it refuses in a way that looks
 * retryable: the transfer aborts rather than returning a clean 403, so
 * `is_network_error` matches on the message and `with_graph_retry` spends its
 * full ~23 minute budget on content that will never arrive. The pipeline
 * therefore has to skip the item on the `malware` facet, before any download.
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import type { OneDriveConnector, OneDriveDeltaItem, TenantContext } from '@wisecom/atlas-types';
import {
  process_delta_item,
  type DriveTrackingState,
  type VersionStats,
} from '@/services/onedrive-delta-item-processor';
import type { RunVersionCollector } from '@/services/onedrive-version-sync';

function make_item(overrides: Partial<OneDriveDeltaItem> = {}): OneDriveDeltaItem {
  return {
    item_id: 'item-1',
    drive_id: 'drive-1',
    kind: 'file',
    file_name: 'infected.docx',
    parent_path: '/',
    size_bytes: 68,
    deleted: false,
    etag: 'etag-1',
    ...overrides,
  };
}

function make_state(): DriveTrackingState {
  return {
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
  };
}

function make_connector(): { connector: OneDriveConnector; download: Mock } {
  const download = vi.fn(async () => Buffer.from('content'));
  const connector = {
    download_file_content: download,
    list_file_versions: vi.fn(async () => []),
  } as unknown as OneDriveConnector;
  return { connector, download };
}

function make_context(): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: {
      exists: vi.fn(async () => false),
      put: vi.fn(async () => undefined),
    },
    encrypt: (buffer: Buffer) => buffer,
  } as unknown as TenantContext;
}

async function run(item: OneDriveDeltaItem) {
  const { connector, download } = make_connector();
  const versions: RunVersionCollector = { watermarks: {}, rows: new Map() };
  const version_stats: VersionStats = {
    total_versions_stored: 0,
    total_versions_unavailable: 0,
    total_versions_failed: 0,
  };

  const outcome = await process_delta_item(
    connector,
    item,
    'owner-1',
    'snap-1',
    make_context(),
    make_state(),
    version_stats,
    () => undefined,
    versions,
  );

  return { outcome, download };
}

describe('process_delta_item with a quarantined file (#53)', () => {
  it('never attempts the download', async () => {
    const { download } = await run(make_item({ quarantined: true }));

    expect(download).not.toHaveBeenCalled();
  });

  it('reports the block as permanent so later runs stop re-fetching it', async () => {
    const { outcome } = await run(make_item({ quarantined: true }));

    expect(outcome.permanent).toBe(true);
    expect(outcome.error).toContain('Quarantined');
    expect(outcome.error).toContain('infected.docx');
  });

  it('stores no entry and counts no file', async () => {
    const { outcome } = await run(make_item({ quarantined: true }));

    expect(outcome.entry).toBeUndefined();
    expect(outcome.files_stored).toBe(0);
    expect(outcome.files_deduplicated).toBe(0);
    expect(outcome.deleted_items).toBe(0);
  });

  it('still downloads a file that is not quarantined', async () => {
    const { outcome, download } = await run(make_item());

    expect(download).toHaveBeenCalledTimes(1);
    expect(outcome.error).toBeUndefined();
    expect(outcome.entry?.file_id).toBe('item-1');
  });

  it('treats a deleted quarantined item as a deletion, not a block', async () => {
    const { outcome, download } = await run(make_item({ quarantined: true, deleted: true }));

    expect(download).not.toHaveBeenCalled();
    expect(outcome.deleted_items).toBe(1);
    expect(outcome.error).toBeUndefined();
  });
});
