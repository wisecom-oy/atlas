import { describe, expect, it, vi } from 'vitest';
import type {
  BackupProgressReporter,
  DeltaPageCallback,
  DeltaSyncResult,
  MailMessage,
  Manifest,
} from '@wisecom/atlas-types';
import { latest_readable } from '@wisecom/atlas-types/testing/readable-listing';
import { create_mailbox_sync_harness, make_message } from './mailbox-sync.fixtures';
import type { MailboxSyncHarness } from './mailbox-sync.fixtures';

/**
 * Issue #851. A folder whose delta round ended on a page with neither `@odata.nextLink` nor
 * `@odata.deltaLink` was printed `[ok]` and the run exited 0, with every message on the pages never
 * requested missing from the snapshot. The round is now a folder error and the folder keeps its
 * previous link.
 */

const OWNER = 'john.doe@example.com';
const PREVIOUS_LINK = 'https://delta/link-0';
const NEXT_LINK = 'https://delta/link-1';

/** A connector round that hands each page to on_page and ends with `final_link`. */
function paged_round(pages: MailMessage[][], final_link: string, after_page?: () => void) {
  return async (
    _tenant: string,
    _owner: string,
    _folder: string,
    _prev?: string,
    on_page?: DeltaPageCallback,
  ): Promise<DeltaSyncResult> => {
    let streamed = 0;
    for (const [index, page] of pages.entries()) {
      streamed += page.length;
      if ((await on_page?.(index + 1, streamed, page)) === false) break;
      after_page?.();
    }
    return { messages: [], removed_ids: ['msg-gone'], delta_link: final_link, delta_reset: false };
  };
}

function make_progress(): BackupProgressReporter {
  return {
    set_status: vi.fn(),
    mark_active: vi.fn(),
    update_active: vi.fn(),
    update_paging: vi.fn(),
    mark_done: vi.fn(),
    mark_all_pending_interrupted: vi.fn(),
    mark_error: vi.fn(),
    update_total: vi.fn(),
    finish: vi.fn(),
  };
}

/** A harness resuming Inbox from PREVIOUS_LINK after an earlier backup of it. */
function harness_resuming_inbox(final_link: string, after_page?: () => void): MailboxSyncHarness {
  const harness = create_mailbox_sync_harness();
  vi.mocked(harness.mock_cursors.load).mockResolvedValue({
    owner_id: OWNER,
    delta_links: { 'folder-1': PREVIOUS_LINK },
    updated_at: '2026-10-01T00:00:00.000Z',
  });
  vi.mocked(harness.mock_manifests.find_latest_readable).mockResolvedValue(
    latest_readable({
      snapshot_id: 'snap-head',
      total_objects: 3,
      delta_links: { 'folder-1': PREVIOUS_LINK },
      id_format: 'immutable',
      entries: [],
    } as unknown as Manifest),
  );
  const pages = [[make_message('msg-1', 'first')], [make_message('msg-2', 'second')]];
  vi.mocked(harness.mock_connector.fetch_delta).mockImplementation(
    paged_round(pages, final_link, after_page),
  );
  return harness;
}

function saved_links(harness: MailboxSyncHarness): Record<string, string> {
  return vi.mocked(harness.mock_cursors.save).mock.lastCall![1].delta_links;
}

describe('an outlook folder whose delta round ends without a delta link', () => {
  it('is reported as a folder error rather than done', async () => {
    const harness = harness_resuming_inbox('');
    const progress = make_progress();

    const result = await harness.service.sync_mailbox('t', OWNER, { progress });

    expect(result.summary.folder_errors).toEqual([
      expect.stringMatching(/^Inbox: The message delta of this folder ended without a delta link/),
    ]);
    expect(progress.mark_error).toHaveBeenCalledOnce();
    expect(progress.mark_done).not.toHaveBeenCalled();
  });

  it('keeps the previous delta link and records no removals', async () => {
    const harness = harness_resuming_inbox('');

    const result = await harness.service.sync_mailbox('t', OWNER);

    expect(saved_links(harness)).toEqual({ 'folder-1': PREVIOUS_LINK });
    expect(result.manifest.removed_object_ids).toBeUndefined();
  });

  it('is done and advances the link when the round ends with one', async () => {
    const harness = harness_resuming_inbox(NEXT_LINK);
    const progress = make_progress();

    const result = await harness.service.sync_mailbox('t', OWNER, { progress });

    expect(result.summary.folder_errors).toEqual([]);
    expect(progress.mark_done).toHaveBeenCalledOnce();
    expect(saved_links(harness)).toEqual({ 'folder-1': NEXT_LINK });
    expect(result.manifest.removed_object_ids).toEqual(['msg-gone']);
  });

  it('is an interrupt, not a folder error, when the run stops mid-round', async () => {
    let interrupted = false;
    const harness = harness_resuming_inbox('', () => {
      interrupted = true;
    });

    const result = await harness.service.sync_mailbox('t', OWNER, {
      should_interrupt: () => interrupted,
    });

    expect(result.summary.folder_errors).toEqual([]);
    expect(result.summary.interrupted).toBe(true);
    expect(saved_links(harness)).toEqual({ 'folder-1': PREVIOUS_LINK });
  });
});
