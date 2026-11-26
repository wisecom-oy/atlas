import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GraphAccessRefusedError,
  GraphUnavailableError,
  ThrottledError,
} from '@wisecom/atlas-types';
import type { MailboxDeltaCursor, Manifest, SyncResult } from '@wisecom/atlas-types';
import {
  GraphOutageFault,
  RETRY_BUDGET_SPAN_MS,
} from '@wisecom/atlas-types/testing/graph-outage-fault';
import { latest_readable } from '@wisecom/atlas-types/testing/readable-listing';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import { create_mailbox_sync_harness, make_delta, make_message } from './mailbox-sync.fixtures';
import type { MailboxSyncHarness } from './mailbox-sync.fixtures';

/**
 * Issue #869. A backup in which every folder failed because Microsoft Graph was unavailable
 * exited 2, the code of one failed message, and named no Atlas code on its folder lines. Since the
 * outage latch (#881) such a run rejects with the outage, which the CLI maps to exit 3. These pin
 * what a caller sees: the rejection carries the run's result, each folder failure names its code
 * and whether it was transient, and no failed folder moves its delta link.
 */

const OWNER = 'user@example.com';
const FOLDERS = ['folder-1', 'folder-2', 'folder-3'];
const PREVIOUS_LINKS = {
  'folder-1': 'https://delta/folder-1/0',
  'folder-2': 'https://delta/folder-2/0',
  'folder-3': 'https://delta/folder-3/0',
};
const NEXT_LINK = 'https://delta/next';

/** Three folders, each backed up before, so every one has a delta link to keep or replace. */
function seed_previous_backup(harness: MailboxSyncHarness): void {
  vi.mocked(harness.mock_connector.list_mail_folders).mockResolvedValue(
    FOLDERS.map((folder_id, index) => ({
      folder_id,
      display_name: `Folder ${index + 1}`,
      folder_path: `Folder ${index + 1}`,
      total_item_count: 2,
    })),
  );
  const cursor: MailboxDeltaCursor = {
    owner_id: OWNER,
    delta_links: PREVIOUS_LINKS,
    updated_at: new Date(0).toISOString(),
  };
  const head: Manifest = {
    id: 'manifest-0',
    tenant_id: 't',
    owner_id: OWNER,
    snapshot_id: 'snapshot-0',
    created_at: new Date(0),
    total_objects: 0,
    total_size_bytes: 0,
    delta_links: PREVIOUS_LINKS,
    id_format: 'immutable',
    entries: [],
  };
  vi.mocked(harness.mock_cursors.load).mockResolvedValue(cursor);
  vi.mocked(harness.mock_manifests.find_latest_readable).mockResolvedValue(latest_readable(head));
}

async function run_backup(harness: MailboxSyncHarness): Promise<unknown> {
  const run = harness.service.sync_mailbox('t', OWNER).catch((err: unknown) => err);
  await vi.advanceTimersByTimeAsync(RETRY_BUDGET_SPAN_MS);
  return run;
}

/** The links the next run resumes from: the saved cursor's, or the previous ones if none was saved. */
function saved_cursor_links(harness: MailboxSyncHarness): Record<string, string> {
  return vi.mocked(harness.mock_cursors.save).mock.lastCall?.[1].delta_links ?? PREVIOUS_LINKS;
}

describe('an Outlook backup whose folders failed (issue #869)', () => {
  let harness: MailboxSyncHarness;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = create_mailbox_sync_harness();
    seed_previous_backup(harness);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with the outage when every folder failed on it, carrying each transient failure', async () => {
    const graph = new GraphOutageFault();
    vi.mocked(harness.mock_connector.fetch_delta).mockImplementation(async () =>
      with_graph_retry(graph.send),
    );

    const outcome = await run_backup(harness);

    expect(outcome).toBeInstanceOf(GraphUnavailableError);
    const partial = (outcome as GraphUnavailableError).partial_result as SyncResult;
    expect(partial.summary.completed_folder_count).toBe(0);
    expect(partial.summary.folder_failures).toEqual(
      FOLDERS.map((folder_id, index) => ({
        folder_id,
        folder_path: `Folder ${index + 1}`,
        message: expect.stringContaining('Microsoft Graph was unavailable'),
        code: 'ATLAS_GRAPH_UNAVAILABLE',
        transient: true,
      })),
    );
    expect(partial.summary.folder_errors).toEqual(
      FOLDERS.map((_, index) =>
        expect.stringMatching(
          new RegExp(`^Folder ${index + 1}: .*\\(Atlas code: ATLAS_GRAPH_UNAVAILABLE\\)$`),
        ),
      ),
    );
    expect(saved_cursor_links(harness)).toEqual(PREVIOUS_LINKS);
    // Nothing changed since the previous snapshot, so none is written and that one is reported.
    expect(harness.mock_manifests.save).not.toHaveBeenCalled();
    expect(partial.snapshot.id).toBe('snapshot-0');
  });

  it('tells the caller about the empty snapshot a first backup commits before rejecting', async () => {
    vi.mocked(harness.mock_cursors.load).mockResolvedValue(undefined);
    vi.mocked(harness.mock_manifests.find_latest_readable).mockResolvedValue(
      latest_readable<Manifest>(undefined),
    );
    const graph = new GraphOutageFault();
    vi.mocked(harness.mock_connector.fetch_delta).mockImplementation(async () =>
      with_graph_retry(graph.send),
    );

    const outcome = await run_backup(harness);

    expect(outcome).toBeInstanceOf(GraphUnavailableError);
    const partial = (outcome as GraphUnavailableError).partial_result as SyncResult;
    const saved = vi.mocked(harness.mock_manifests.save).mock.lastCall?.[1];
    expect(saved?.entries).toEqual([]);
    expect(partial.snapshot.id).toBe(saved?.snapshot_id);
    expect(partial.snapshot.object_count).toBe(0);
  });

  it('names ATLAS_THROTTLED for a folder whose throttle outlasted the budget', async () => {
    vi.mocked(harness.mock_connector.fetch_delta).mockImplementation(async (_t, _o, folder_id) => {
      if (folder_id === 'folder-2') throw new ThrottledError('kept throttling', 30_000);
      return make_delta([], NEXT_LINK);
    });

    const result = (await run_backup(harness)) as SyncResult;

    expect(result.summary.folder_failures).toEqual([
      {
        folder_id: 'folder-2',
        folder_path: 'Folder 2',
        message: 'kept throttling',
        code: 'ATLAS_THROTTLED',
        transient: true,
      },
    ]);
    expect(result.summary.folder_errors).toEqual([
      'Folder 2: kept throttling (Atlas code: ATLAS_THROTTLED)',
    ]);
    expect(saved_cursor_links(harness)['folder-2']).toBe(PREVIOUS_LINKS['folder-2']);
  });

  it('resolves, partial, when a folder failed for another reason and the others completed', async () => {
    const refused = new GraphAccessRefusedError('Graph refused the folder', {}, 'access_refused');
    vi.mocked(harness.mock_connector.fetch_delta).mockImplementation(async (_t, _o, folder_id) => {
      if (folder_id === 'folder-3') throw refused;
      return make_delta([make_message(`${folder_id}-msg`, '{}')], NEXT_LINK);
    });

    const result = (await run_backup(harness)) as SyncResult;

    expect(result).not.toBeInstanceOf(Error);
    expect(result.summary.completed_folder_count).toBe(2);
    expect(result.summary.folder_failures).toEqual([
      expect.objectContaining({
        folder_id: 'folder-3',
        code: 'ATLAS_ACCESS_REFUSED',
        transient: false,
      }),
    ]);
    expect(saved_cursor_links(harness)).toEqual({
      'folder-1': NEXT_LINK,
      'folder-2': NEXT_LINK,
      'folder-3': PREVIOUS_LINKS['folder-3'],
    });
  });

  it('records a failure Atlas did not classify without a code, as not transient', async () => {
    vi.mocked(harness.mock_connector.fetch_delta).mockImplementation(async (_t, _o, folder_id) => {
      if (folder_id === 'folder-1') throw new Error('unexpected');
      return make_delta([], NEXT_LINK);
    });

    const result = (await run_backup(harness)) as SyncResult;

    expect(result.summary.folder_failures).toEqual([
      { folder_id: 'folder-1', folder_path: 'Folder 1', message: 'unexpected', transient: false },
    ]);
    expect(result.summary.folder_errors).toEqual(['Folder 1: unexpected']);
  });
});
