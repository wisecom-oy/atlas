import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import type { OneDriveDeltaCursor, OneDriveSnapshotManifest } from '@wisecom/atlas-types';
import { OwnerBusyError, OwnerLeaseLostError } from '@wisecom/atlas-types';
import { tenant_factory_for } from '@wisecom/atlas-types/testing/stub-contacts-ports';
import {
  stub_drive_stores,
  stub_graph_drive,
} from '@wisecom/atlas-types/testing/stub-drive-backup-rig';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

import { OneDriveBackupService } from '@/services/backup/backup.service';

/**
 * Issue #623: two backups of one OneDrive overwrote each other's delta cursor with no error, and
 * the failed-item ledger inside it, so a file was never retried. The backup now runs under the
 * owner's lease.
 */
const OWNER = '00000000-0000-0000-0000-00000000abcd';
const LEASE = { workload: 'onedrive', owner_id: OWNER, operation: 'backup' } as const;

function harness() {
  const drive = stub_graph_drive();
  drive.put_file('Budget.xlsx');
  const stores = stub_drive_stores<OneDriveSnapshotManifest, OneDriveDeltaCursor>(
    'onedrive',
    OWNER,
  );
  const leases = stub_owner_leases();
  const cursor_loads: string[] = [];
  const connector = {
    list_drives: async () => [{ drive_id: drive.drive_id, drive_name: 'OneDrive' }],
    fetch_delta: async (_tenant: string, _owner: string, _drive: string, link?: string) =>
      drive.delta(link),
    fetch_item_by_id: async () => undefined,
    download_file_content: async (item: { item_id: string; etag?: string }) =>
      Buffer.from(`${item.item_id}:${item.etag}`),
    list_file_versions: async () => [],
  };
  const service = new OneDriveBackupService(
    tenant_factory_for(stores.ctx),
    connector as never,
    {
      save: stores.save_manifest,
      find_latest_readable: stores.find_latest_readable,
      list_readable_snapshots_by_owner: stores.list_readable_snapshots,
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
  return { service, connector, drive, stores, leases, cursor_loads };
}

describe('OneDrive backup under the owner lease (issue #623)', () => {
  it('takes the lease before it reads the cursor and releases it after the run', async () => {
    const h = harness();

    const result = await h.service.backup_onedrive('tenant-1', OWNER.toUpperCase());

    expect(result.summary.snapshot_created).toBe(true);
    expect(h.leases.requests).toEqual([LEASE]);
    expect(h.cursor_loads).toEqual(['acquire']);
    // One check before the manifest and one before the cursor, then the release.
    expect(h.leases.events).toEqual(['acquire', 'assert', 'assert', 'release']);
    expect(h.leases.held()).toBe(0);
  });

  it('checks the lease before the cursor of a run that found nothing to snapshot', async () => {
    const h = harness();
    await h.service.backup_onedrive('tenant-1', OWNER);
    h.leases.events.length = 0;

    const quiet = await h.service.backup_onedrive('tenant-1', OWNER);

    expect(quiet.summary.snapshot_created).toBe(false);
    // One check before the run index and one before the cursor.
    expect(h.leases.events).toEqual(['acquire', 'assert', 'assert', 'release']);
  });

  it('fails before reading the cursor and writes nothing while another run holds the owner', async () => {
    const h = harness();
    h.leases.refuse_with(new OwnerBusyError({ ...LEASE, held_by_operation: 'backup' }));

    await expect(h.service.backup_onedrive('tenant-1', OWNER)).rejects.toBeInstanceOf(
      OwnerBusyError,
    );

    expect(h.cursor_loads).toEqual([]);
    expect(h.drive.requested_links).toEqual([]);
    expect(h.stores.stored_manifests()).toEqual([]);
    expect(h.stores.saved_cursors).toEqual([]);
  });

  it('writes neither manifest nor cursor once the lease is lost mid-run', async () => {
    const h = harness();
    h.leases.fail_checks_with(new OwnerLeaseLostError(LEASE, 'another operation replaced it'));

    await expect(h.service.backup_onedrive('tenant-1', OWNER)).rejects.toBeInstanceOf(
      OwnerLeaseLostError,
    );

    // The drive was read, so the run got as far as its first commit point.
    expect(h.drive.requested_links).toEqual([undefined]);
    expect(h.stores.stored_manifests()).toEqual([]);
    expect(h.stores.saved_cursors).toEqual([]);
    expect(h.leases.held()).toBe(0);
  });

  it('releases the lease when the run fails', async () => {
    const h = harness();
    h.connector.list_drives = async () => {
      throw new Error('graph unavailable');
    };

    await expect(h.service.backup_onedrive('tenant-1', OWNER)).rejects.toThrow('graph unavailable');

    expect(h.leases.events).toEqual(['acquire', 'release']);
  });

  it('releases the lease when the run is cancelled inside a Graph call', async () => {
    const h = harness();
    const abort = new AbortController();
    h.connector.list_drives = async () => {
      abort.abort();
      throw abort.signal.reason;
    };

    const result = await h.service.backup_onedrive('tenant-1', OWNER, {
      abort_signal: abort.signal,
    });

    expect(result.interrupted).toBe(true);
    expect(h.stores.saved_cursors).toEqual([]);
    expect(h.leases.events).toEqual(['acquire', 'release']);
  });
});
