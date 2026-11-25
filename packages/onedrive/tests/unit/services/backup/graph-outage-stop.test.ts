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
  type StubGraphDrive,
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
 * Issue #881: a Graph outage that outlasts the retry budget costs a OneDrive backup one budget, not
 * one per drive. The drive read before the outage is committed with its new delta link, the drives
 * after it keep their previous links, and the run rejects with the outage.
 */
const OWNER = '00000000-0000-0000-0000-00000000abcd';

function harness() {
  const drives = ['drive-a', 'drive-b', 'drive-c'].map((id) => stub_graph_drive(id));
  const by_id = new Map<string, StubGraphDrive>(drives.map((d) => [d.drive_id, d]));
  const graph = new GraphOutageFault();
  const outage = { from_drive: undefined as string | undefined };
  const stores = stub_drive_stores<OneDriveSnapshotManifest, OneDriveDeltaCursor>(
    'onedrive',
    OWNER,
  );
  const reached_outage = (drive_id: string): boolean =>
    outage.from_drive !== undefined && drive_id >= outage.from_drive;
  const connector = {
    list_drives: async () => drives.map((d) => ({ drive_id: d.drive_id, drive_name: d.drive_id })),
    fetch_delta: async (_tenant: string, _owner: string, drive_id: string, link?: string) =>
      reached_outage(drive_id) ? with_graph_retry(graph.send) : by_id.get(drive_id)!.delta(link),
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
    { load: stores.load_cursor, save: stores.save_cursor } as never,
    stub_owner_leases().leases,
  );
  const run = (): Promise<OneDriveBackupResult> => service.backup_onedrive('tenant-1', OWNER);
  return { drives, graph, outage, stores, run };
}

/** A baseline run of every drive, then a change on each, so the next run has work everywhere. */
async function baseline(h: ReturnType<typeof harness>): Promise<OneDriveDeltaCursor> {
  for (const drive of h.drives) drive.put_file(`${drive.drive_id}.docx`);
  await h.run();
  for (const drive of h.drives) drive.put_file(`${drive.drive_id}-new.docx`);
  return h.stores.saved_cursors.at(-1)!;
}

describe('a OneDrive backup during a Graph outage (#881)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('spends one retry budget, commits the drive read before it, and rejects with the outage', async () => {
    const h = harness();
    const before = await baseline(h);
    h.outage.from_drive = 'drive-b';

    const outcome = h.run().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET_SPAN_MS);

    expect(await outcome).toBeInstanceOf(GraphUnavailableError);
    expect(h.graph.requests).toBe(ATTEMPTS_PER_RETRY_CHAIN);
    const after = h.stores.saved_cursors.at(-1)!;
    expect(after).not.toBe(before);
    expect(after.delta_link_by_drive['drive-a']).not.toBe(before.delta_link_by_drive['drive-a']);
    expect(after.delta_link_by_drive['drive-b']).toBe(before.delta_link_by_drive['drive-b']);
    expect(after.delta_link_by_drive['drive-c']).toBe(before.delta_link_by_drive['drive-c']);
    expect(Object.keys(after.failed_items ?? {})).toEqual([]);
    const newest = h.stores.stored_manifests().at(-1)!;
    expect(newest.entries.map((e) => e.file_name)).toEqual(['drive-a-new.docx']);
  });

  it('commits nothing new and keeps every link when the outage starts with the first drive', async () => {
    const h = harness();
    const before = await baseline(h);
    const manifests_before = h.stores.stored_manifests().length;
    h.outage.from_drive = 'drive-a';

    const outcome = h.run().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET_SPAN_MS);

    expect(await outcome).toBeInstanceOf(GraphUnavailableError);
    expect(h.graph.requests).toBe(ATTEMPTS_PER_RETRY_CHAIN);
    expect(h.stores.stored_manifests()).toHaveLength(manifests_before);
    expect(h.stores.saved_cursors.at(-1)?.delta_link_by_drive).toEqual(before.delta_link_by_drive);
  });
});
