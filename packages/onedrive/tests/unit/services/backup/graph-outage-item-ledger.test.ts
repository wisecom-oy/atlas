import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GraphUnavailableError,
  type OneDriveBackupResult,
  type OneDriveDeltaCursor,
  type OneDriveSnapshotManifest,
} from '@wisecom/atlas-types';
import { tenant_factory_for } from '@wisecom/atlas-types/testing/stub-contacts-ports';
import {
  stub_drive_stores,
  stub_graph_drive,
} from '@wisecom/atlas-types/testing/stub-drive-backup-rig';
import {
  ATTEMPTS_PER_RETRY_CHAIN,
  GraphOutageFault,
  RETRY_BUDGET_SPAN_MS,
} from '@wisecom/atlas-types/testing/graph-outage-fault';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import { OneDriveBackupService } from '@/services/backup/backup.service';

/**
 * Issue #881: a Graph outage met while one item is processed, or while a failed item is fetched
 * again, is not that item's fault. It fails the drive, which keeps its delta link, and spends no
 * attempt of the item's failed-item ledger. An ordinary item failure is still recorded.
 */
const OWNER = '00000000-0000-0000-0000-00000000abcd';
const FILE_ID = 'id-Report.docx';

type Step = (() => Promise<unknown>) | undefined;

function harness() {
  const drive = stub_graph_drive();
  const graph = new GraphOutageFault();
  const fault: { download: Step; versions: Step; fetch: Step } = {
    download: undefined,
    versions: undefined,
    fetch: undefined,
  };
  const stores = stub_drive_stores<OneDriveSnapshotManifest, OneDriveDeltaCursor>(
    'onedrive',
    OWNER,
  );
  const connector = {
    list_drives: async () => [{ drive_id: drive.drive_id, drive_name: 'OneDrive' }],
    fetch_delta: async (_tenant: string, _owner: string, _drive: string, link?: string) =>
      drive.delta(link),
    fetch_item_by_id: async (_t: string, _o: string, _d: string, item_id: string) =>
      fault.fetch ? fault.fetch() : drive.delta().items.find((item) => item.item_id === item_id),
    download_file_content: async (item: { item_id: string; etag?: string }) =>
      fault.download ? fault.download() : Buffer.from(`${item.item_id}:${item.etag}`),
    list_file_versions: async () => (fault.versions ? fault.versions() : []),
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
    { load: stores.load_cursor, save: stores.save_cursor } as never,
    stub_owner_leases().leases,
  );
  const outage: Step = () => with_graph_retry(graph.send);
  const broken =
    (what: string): Step =>
    async () => {
      throw new Error(`${what} broken`);
    };
  const run = async (): Promise<OneDriveBackupResult | unknown> => {
    const outcome = service.backup_onedrive('tenant-1', OWNER).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET_SPAN_MS);
    return outcome;
  };
  const cursor = (): OneDriveDeltaCursor => stores.saved_cursors.at(-1)!;
  return { drive, graph, fault, stores, outage, broken, run, cursor };
}

/** Leaves `Report.docx` in the drive's ledger after one failed download. */
async function ledger_with_one_failure(h: ReturnType<typeof harness>): Promise<number> {
  h.drive.put_file('Budget.xlsx');
  await h.run();
  h.drive.put_file('Report.docx');
  h.fault.download = h.broken('download');
  await h.run();
  h.fault.download = undefined;
  const attempts = h.cursor().failed_items?.[FILE_ID]?.attempts;
  expect(attempts).toBe(1);
  return attempts!;
}

describe('OneDrive item failures during a Graph outage (#881)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fails the drive on an outage while processing an item, recording no ledger entry', async () => {
    const h = harness();
    h.drive.put_file('Budget.xlsx');
    await h.run();
    const link_before = h.cursor().delta_link_by_drive[h.drive.drive_id];
    h.drive.put_file('Report.docx');
    h.fault.versions = h.outage;

    const outcome = await h.run();

    expect(outcome).toBeInstanceOf(GraphUnavailableError);
    expect(h.graph.requests).toBe(ATTEMPTS_PER_RETRY_CHAIN);
    expect(h.cursor().failed_items?.[FILE_ID]).toBeUndefined();
    expect(h.cursor().delta_link_by_drive[h.drive.drive_id]).toBe(link_before);
  });

  it('still records an ordinary download failure against the item', async () => {
    await ledger_with_one_failure(harness());
  });

  it('spends no ledger attempt when the refetch of a failed item meets an outage', async () => {
    const h = harness();
    const attempts = await ledger_with_one_failure(h);
    h.fault.fetch = h.outage;

    const outcome = await h.run();

    expect(outcome).toBeInstanceOf(GraphUnavailableError);
    expect(h.graph.requests).toBe(ATTEMPTS_PER_RETRY_CHAIN);
    expect(h.cursor().failed_items?.[FILE_ID]?.attempts).toBe(attempts);
  });

  it('still spends an attempt when the refetch fails on its own', async () => {
    const h = harness();
    const attempts = await ledger_with_one_failure(h);
    h.fault.fetch = h.broken('fetch');

    await h.run();

    expect(h.cursor().failed_items?.[FILE_ID]).toMatchObject({
      attempts: attempts + 1,
      reason: expect.stringContaining('Retry fetch failed: fetch broken'),
    });
  });
});
