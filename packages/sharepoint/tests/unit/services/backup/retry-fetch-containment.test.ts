import { describe, expect, it, vi } from 'vitest';
import { AuthError } from '@wisecom/atlas-types';
import type { SharePointSiteConnector, TenantContext } from '@wisecom/atlas-types';
import { retry_failed_items } from '@/services/backup/library-item-processor';
import { record_item_failure } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import type { FailedItemLedger } from '@wisecom/atlas-core/services/shared/failed-item-ledger';

/**
 * Issue #371. The retry re-fetched each ledger item with `fetch_item_by_id` and awaited it
 * unguarded, so one transient failure travelled out of the library processor into the library
 * scan, which recorded a library-level error and dropped the entries the same run had already
 * processed. The OneDrive twin catches it per item.
 */

function make_ledger(): FailedItemLedger {
  let ledger: FailedItemLedger = {};
  for (const item_id of ['item-1', 'item-2']) {
    ledger = record_item_failure(ledger, {
      item_id,
      drive_id: 'drive-1',
      name: `${item_id}.docx`,
      reason: 'download refused',
    });
  }
  return ledger;
}

function make_ctx(): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: { exists: vi.fn().mockResolvedValue(true), put: vi.fn(), get: vi.fn() },
    encrypt: (data: Buffer) => data,
    decrypt: (data: Buffer) => data,
    destroy: vi.fn(),
  } as unknown as TenantContext;
}

async function run(failure: Error): Promise<FailedItemLedger> {
  const connector = {
    fetch_item_by_id: vi.fn(async (_t: string, _s: string, _d: string, item_id: string) => {
      if (item_id === 'item-1') throw failure;
      return undefined;
    }),
  } as unknown as SharePointSiteConnector;

  const library_state = {
    entries: [],
    failed_items: make_ledger(),
    files_stored: 0,
    files_deduplicated: 0,
    deleted_items: 0,
  };

  await retry_failed_items(
    connector,
    'tenant-1',
    'site-1',
    'snap-1',
    'drive-1',
    make_ctx(),
    { previous_path_by_file_id: {}, previous_etag_by_file_id: {} } as never,
    library_state as never,
    { watermarks: {}, rows: [] } as never,
    { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 } as never,
  );

  return library_state.failed_items;
}

describe('a transient fetch failure while retrying a failed SharePoint item', () => {
  it('records the item and lets the rest of the library finish', async () => {
    const ledger = await run(new Error('500 Internal Server Error'));

    expect(ledger['item-1']?.reason).toContain('Retry fetch failed');
    // item-2 answered "gone" and was cleared, which only happens if the loop kept going.
    expect(ledger['item-2']).toBeUndefined();
  });

  it('still stops the run for a revoked permission', async () => {
    await expect(run(new AuthError('403 from Graph'))).rejects.toBeInstanceOf(AuthError);
  });
});
