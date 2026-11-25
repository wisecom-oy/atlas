import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphUnavailableError } from '@wisecom/atlas-types';
import type { MailboxDeltaCursor, Manifest } from '@wisecom/atlas-types';
import {
  ATTEMPTS_PER_RETRY_CHAIN,
  GraphOutageFault,
  RETRY_BUDGET_SPAN_MS,
} from '@wisecom/atlas-types/testing/graph-outage-fault';
import { latest_readable } from '@wisecom/atlas-types/testing/readable-listing';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import { create_mailbox_sync_harness, make_delta, make_message } from './mailbox-sync.fixtures';
import type { MailboxSyncHarness } from './mailbox-sync.fixtures';

/**
 * Issue #881. A Graph outage that outlasted the retry budget cost one ~23.5 minute budget per
 * folder and per message, one after another, while the run held the mailbox lease. The first
 * exhausted call now ends every other Graph call of the run: the run commits the folders it
 * finished, the failed ones keep their previous delta link, and the run rejects with the outage.
 */

const OWNER = 'user@example.com';
const FOLDERS = ['folder-1', 'folder-2', 'folder-3'];
const PREVIOUS_LINKS = {
  'folder-1': 'https://delta/folder-1/0',
  'folder-2': 'https://delta/folder-2/0',
  'folder-3': 'https://delta/folder-3/0',
};
const NEXT_LINK = 'https://delta/folder-1/1';
const MIME = Buffer.from('Subject: Hi\r\n\r\nbody\r\n');

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
    total_objects: 6,
    total_size_bytes: 0,
    delta_links: PREVIOUS_LINKS,
    id_format: 'immutable',
    entries: [],
  };
  vi.mocked(harness.mock_cursors.load).mockResolvedValue(cursor);
  vi.mocked(harness.mock_manifests.find_latest_readable).mockResolvedValue(latest_readable(head));
}

/** Runs the backup while simulated time covers a retry budget, and returns how it ended. */
async function run_backup(harness: MailboxSyncHarness): Promise<unknown> {
  const run = harness.service.sync_mailbox('t', OWNER).catch((err: unknown) => err);
  await vi.advanceTimersByTimeAsync(RETRY_BUDGET_SPAN_MS);
  return run;
}

/** The links the next run resumes from: the saved cursor's, or the previous ones if none was saved. */
function saved_cursor_links(harness: MailboxSyncHarness): Record<string, string> {
  return vi.mocked(harness.mock_cursors.save).mock.lastCall?.[1].delta_links ?? PREVIOUS_LINKS;
}

/** Ids of every entry the run committed to a manifest. */
function committed_ids(harness: MailboxSyncHarness): string[] {
  return vi
    .mocked(harness.mock_manifests.save)
    .mock.calls.flatMap(([, manifest]) => manifest.entries.map((entry) => entry.object_id));
}

describe('an Outlook backup under a whole-run Graph outage', () => {
  let harness: MailboxSyncHarness;
  let graph: GraphOutageFault;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = create_mailbox_sync_harness();
    graph = new GraphOutageFault();
    seed_previous_backup(harness);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spends one retry budget across every folder, commits the finished folder, and rejects', async () => {
    vi.mocked(harness.mock_connector.fetch_delta).mockImplementation(async (_t, _o, folder_id) => {
      if (folder_id === 'folder-1') {
        return make_delta([make_message('msg-1', '{"id":"msg-1"}')], NEXT_LINK);
      }
      return with_graph_retry(graph.send);
    });

    const outcome = await run_backup(harness);

    expect(outcome).toBeInstanceOf(GraphUnavailableError);
    expect(graph.requests).toBe(ATTEMPTS_PER_RETRY_CHAIN);
    expect(saved_cursor_links(harness)).toEqual({ ...PREVIOUS_LINKS, 'folder-1': NEXT_LINK });
    expect(committed_ids(harness)).toEqual(['msg-1']);
    expect(harness.leases.held()).toBe(0);
    expect(harness.leases.events.at(-1)).toBe('release');
  });

  it('fails the folder on an exhausted MIME read instead of storing JSON stand-ins', async () => {
    vi.mocked(harness.mock_connector.fetch_delta).mockImplementation(async (_t, _o, folder_id) => {
      if (folder_id !== 'folder-1') return with_graph_retry(graph.send);
      const page = ['msg-1', 'msg-2', 'msg-3'].map((id) => make_message(id, `{"id":"${id}"}`));
      return make_delta(page, NEXT_LINK);
    });
    harness.mock_connector.fetch_mime = vi.fn(async (): Promise<Buffer | undefined> =>
      with_graph_retry(graph.send),
    );

    const outcome = await run_backup(harness);

    expect(outcome).toBeInstanceOf(GraphUnavailableError);
    expect(graph.requests).toBe(ATTEMPTS_PER_RETRY_CHAIN);
    expect(harness.mock_connector.fetch_mime).toHaveBeenCalledTimes(1);
    expect(harness.mock_context.storage.put).not.toHaveBeenCalled();
    expect(committed_ids(harness)).toEqual([]);
    expect(saved_cursor_links(harness)).toEqual(PREVIOUS_LINKS);
    expect(harness.leases.held()).toBe(0);
  });

  it('still fails only the message whose MIME read Graph refused, and finishes', async () => {
    vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue(
      make_delta([make_message('msg-1', '{}'), make_message('msg-2', '{}')], NEXT_LINK),
    );
    harness.mock_connector.fetch_mime = vi.fn(async (_t: string, _o: string, id: string) => {
      if (id === 'msg-1') throw Object.assign(new Error('Not Found'), { statusCode: 404 });
      return MIME;
    });

    const outcome = await run_backup(harness);

    expect(outcome).not.toBeInstanceOf(Error);
    const { summary } = outcome as { summary: { folder_errors: string[] } };
    expect(summary.folder_errors).toEqual(
      FOLDERS.map((_, index) =>
        expect.stringMatching(
          new RegExp(`^Folder ${index + 1}: message msg-1: original MIME not captured`),
        ),
      ),
    );
  });

  it('rides out an outage that ends within one budget and finishes cleanly', async () => {
    let failures_left = 5;
    vi.mocked(harness.mock_connector.fetch_delta).mockImplementation(async () =>
      with_graph_retry(async () => {
        if (failures_left-- > 0) return graph.send();
        return make_delta([], NEXT_LINK);
      }),
    );

    const outcome = await run_backup(harness);

    expect(outcome).not.toBeInstanceOf(Error);
    expect((outcome as { summary: { folder_errors: string[] } }).summary.folder_errors).toEqual([]);
  });
});
