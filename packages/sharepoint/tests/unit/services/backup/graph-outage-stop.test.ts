import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GraphUnavailableError,
  type SharePointBackupResult,
  type SharePointDeltaCursor,
  type SharePointSnapshotManifest,
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
import { SharePointBackupService } from '@/services/backup/backup.service';

/**
 * Issue #881: a Graph outage that outlasts the retry budget costs a SharePoint site backup one
 * budget, not one per library. The library read before the outage is committed with its new delta
 * link, the libraries after it keep their previous links, and the run rejects with the outage.
 */
const SITE = 'contoso.sharepoint.com,site-guid,web-guid';

function harness() {
  const libraries = ['library-a', 'library-b', 'library-c'].map((id) => stub_graph_drive(id));
  const by_id = new Map<string, StubGraphDrive>(libraries.map((l) => [l.drive_id, l]));
  const graph = new GraphOutageFault();
  const outage = { from_library: undefined as string | undefined };
  const stores = stub_drive_stores<SharePointSnapshotManifest, SharePointDeltaCursor>(
    'sharepoint',
    SITE,
  );
  const reached_outage = (drive_id: string): boolean =>
    outage.from_library !== undefined && drive_id >= outage.from_library;
  const connector = {
    list_document_libraries: async () =>
      libraries.map((library) => ({ drive_id: library.drive_id, drive_name: library.drive_id })),
    fetch_delta: async (_tenant: string, _site: string, drive_id: string, link?: string) =>
      reached_outage(drive_id) ? with_graph_retry(graph.send) : by_id.get(drive_id)!.delta(link),
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
    { load: stores.load_cursor, save: stores.save_cursor } as never,
    stub_owner_leases().leases,
  );
  const run = (): Promise<SharePointBackupResult> => service.backup_site('tenant-1', SITE);
  return { libraries, graph, outage, stores, run };
}

/** A baseline run of every library, then a change on each, so the next run has work everywhere. */
async function baseline(h: ReturnType<typeof harness>): Promise<SharePointDeltaCursor> {
  for (const library of h.libraries) library.put_file(`${library.drive_id}.docx`);
  await h.run();
  for (const library of h.libraries) library.put_file(`${library.drive_id}-new.docx`);
  return h.stores.saved_cursors.at(-1)!;
}

describe('a SharePoint backup during a Graph outage (#881)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('spends one retry budget, commits the library read before it, and rejects with the outage', async () => {
    const h = harness();
    const before = await baseline(h);
    h.outage.from_library = 'library-b';

    const outcome = h.run().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET_SPAN_MS);

    expect(await outcome).toBeInstanceOf(GraphUnavailableError);
    expect(h.graph.requests).toBe(ATTEMPTS_PER_RETRY_CHAIN);
    const links = h.stores.saved_cursors.at(-1)!.delta_link_by_drive;
    expect(links['library-a']).not.toBe(before.delta_link_by_drive['library-a']);
    expect(links['library-b']).toBe(before.delta_link_by_drive['library-b']);
    expect(links['library-c']).toBe(before.delta_link_by_drive['library-c']);
    expect(Object.keys(h.stores.saved_cursors.at(-1)!.failed_items ?? {})).toEqual([]);
    const newest = h.stores.stored_manifests().at(-1)!;
    expect(newest.entries.map((e) => e.file_name)).toEqual(['library-a-new.docx']);
  });

  it('commits nothing new and keeps every link when the outage starts with the first library', async () => {
    const h = harness();
    const before = await baseline(h);
    const manifests_before = h.stores.stored_manifests().length;
    h.outage.from_library = 'library-a';

    const outcome = h.run().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET_SPAN_MS);

    expect(await outcome).toBeInstanceOf(GraphUnavailableError);
    expect(h.graph.requests).toBe(ATTEMPTS_PER_RETRY_CHAIN);
    expect(h.stores.stored_manifests()).toHaveLength(manifests_before);
    expect(h.stores.saved_cursors.at(-1)?.delta_link_by_drive).toEqual(before.delta_link_by_drive);
  });
});
