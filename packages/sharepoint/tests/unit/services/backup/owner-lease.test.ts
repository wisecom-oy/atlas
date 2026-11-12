import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import type { SharePointDeltaCursor, SharePointSnapshotManifest } from '@wisecom/atlas-types';
import { OwnerBusyError, OwnerLeaseLostError } from '@wisecom/atlas-types';
import { tenant_factory_for } from '@wisecom/atlas-types/testing/stub-contacts-ports';
import {
  stub_drive_stores,
  stub_graph_drive,
} from '@wisecom/atlas-types/testing/stub-drive-backup-rig';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

import { SharePointBackupService } from '@/services/backup/backup.service';

/**
 * Issue #623: two backups of one site overwrote each other's delta cursor with no error. The
 * backup now runs under the site's lease.
 */
const SITE = 'contoso.sharepoint.com,site-guid,web-guid';
const LEASE = { workload: 'sharepoint', owner_id: SITE, operation: 'backup' } as const;

function harness() {
  const library = stub_graph_drive('library-documents');
  library.put_file('Budget.xlsx');
  const stores = stub_drive_stores<SharePointSnapshotManifest, SharePointDeltaCursor>(
    'sharepoint',
    SITE,
  );
  const leases = stub_owner_leases();
  const cursor_loads: string[] = [];
  const connector = {
    list_document_libraries: async () => [
      { drive_id: library.drive_id, drive_name: library.drive_id },
    ],
    fetch_delta: async (_tenant: string, _site: string, _drive: string, link?: string) =>
      library.delta(link),
    fetch_item_by_id: async () => undefined,
    download_file_content: async (item: { item_id: string; etag?: string }) =>
      Buffer.from(`${item.item_id}:${item.etag}`),
    list_file_versions: async () => [],
  };
  const service = new SharePointBackupService(
    tenant_factory_for(stores.ctx),
    connector as never,
    {
      save: stores.save_manifest,
      find_latest_readable: stores.find_latest_readable,
      list_readable_snapshots_by_site: stores.list_readable_snapshots,
    } as never,
    {
      load_version_watermarks: stores.load_version_watermarks,
      write_run_index: stores.write_run_index,
    } as never,
    {
      load: async () => {
        // Reading the cursor is only safe once the lease is held.
        cursor_loads.push(leases.events.join(','));
        return stores.load_cursor();
      },
      save: stores.save_cursor,
    } as never,
    leases.leases,
  );
  return { service, connector, library, stores, leases, cursor_loads };
}

describe('SharePoint backup under the site lease (issue #623)', () => {
  it('takes the lease before it reads the cursor and releases it after the run', async () => {
    const h = harness();

    const result = await h.service.backup_site('tenant-1', SITE.toUpperCase());

    expect(result.summary.snapshot_created).toBe(true);
    expect(h.leases.requests).toEqual([LEASE]);
    expect(h.cursor_loads).toEqual(['acquire']);
    // One check before the manifest and one before the cursor, then the release.
    expect(h.leases.events).toEqual(['acquire', 'assert', 'assert', 'release']);
    expect(h.leases.held()).toBe(0);
  });

  it('checks the lease before the cursor of a run that found nothing to snapshot', async () => {
    const h = harness();
    await h.service.backup_site('tenant-1', SITE);
    h.leases.events.length = 0;

    const quiet = await h.service.backup_site('tenant-1', SITE);

    expect(quiet.summary.snapshot_created).toBe(false);
    // One check before the run index and one before the cursor.
    expect(h.leases.events).toEqual(['acquire', 'assert', 'assert', 'release']);
  });

  it('fails before reading the cursor and writes nothing while another run holds the site', async () => {
    const h = harness();
    h.leases.refuse_with(new OwnerBusyError({ ...LEASE, held_by_operation: 'backup' }));

    await expect(h.service.backup_site('tenant-1', SITE)).rejects.toBeInstanceOf(OwnerBusyError);

    expect(h.cursor_loads).toEqual([]);
    expect(h.library.requested_links).toEqual([]);
    expect(h.stores.stored_manifests()).toEqual([]);
    expect(h.stores.saved_cursors).toEqual([]);
  });

  it('writes neither manifest nor cursor once the lease is lost mid-run', async () => {
    const h = harness();
    h.leases.fail_checks_with(new OwnerLeaseLostError(LEASE, 'another operation replaced it'));

    await expect(h.service.backup_site('tenant-1', SITE)).rejects.toBeInstanceOf(
      OwnerLeaseLostError,
    );

    // The library was read, so the run got as far as its first commit point.
    expect(h.library.requested_links).toEqual([undefined]);
    expect(h.stores.stored_manifests()).toEqual([]);
    expect(h.stores.saved_cursors).toEqual([]);
    expect(h.leases.held()).toBe(0);
  });

  it('releases the lease when the run fails', async () => {
    const h = harness();
    h.connector.list_document_libraries = async () => {
      throw new Error('graph unavailable');
    };

    await expect(h.service.backup_site('tenant-1', SITE)).rejects.toThrow('graph unavailable');

    expect(h.leases.events).toEqual(['acquire', 'release']);
  });

  it('releases the lease when the run is cancelled inside a Graph call', async () => {
    const h = harness();
    const abort = new AbortController();
    h.connector.list_document_libraries = async () => {
      abort.abort();
      throw abort.signal.reason;
    };

    const result = await h.service.backup_site('tenant-1', SITE, { abort_signal: abort.signal });

    expect(result.interrupted).toBe(true);
    expect(h.stores.saved_cursors).toEqual([]);
    expect(h.leases.events).toEqual(['acquire', 'release']);
  });
});
