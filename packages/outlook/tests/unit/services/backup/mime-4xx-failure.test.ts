import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailboxDeltaCursor, Manifest, ManifestEntry, SyncResult } from '@wisecom/atlas-types';
import { latest_readable } from '@wisecom/atlas-types/testing/readable-listing';
import { create_mailbox_sync_harness, make_delta, make_message } from './mailbox-sync.fixtures';
import type { MailboxSyncHarness } from './mailbox-sync.fixtures';

/**
 * Issue #849. A `400`, `401` or `404` on `$value` for a message the delta page had just listed was
 * read as "this message has no MIME": the JSON form was stored, nothing was recorded, the folder's
 * delta link advanced and the run exited 0, so no later run asked for the MIME again. The
 * connector now rejects with the Graph error, which holds the link back like any other MIME
 * failure (issue #614).
 */

const OWNER = 'user@example.com';
const MIME = Buffer.from('Subject: Hi\r\n\r\nbody\r\n');
const PREVIOUS_LINK = 'https://delta/link-0';
const NEXT_LINK = 'https://delta/link-1';

/** The shape the Graph SDK rejects a binary `$value` read with: a status and code, no message. */
function graph_refusal(status: number, code: string): Error {
  return Object.assign(new Error(''), { statusCode: status, code });
}

/**
 * Keeps the cursor and the head manifest the way storage would, so the second run resumes from
 * what the first saved. Both start from an earlier backup of the folder.
 */
function persist_state_between_runs(harness: MailboxSyncHarness): void {
  let cursor: MailboxDeltaCursor = {
    owner_id: OWNER,
    delta_links: { 'folder-1': PREVIOUS_LINK },
    updated_at: new Date(0).toISOString(),
  };
  let head: Manifest = {
    id: 'manifest-0',
    tenant_id: 't',
    owner_id: OWNER,
    snapshot_id: 'snapshot-0',
    created_at: new Date(0),
    total_objects: 5,
    total_size_bytes: 0,
    delta_links: cursor.delta_links,
    id_format: 'immutable',
    entries: [],
  };
  vi.mocked(harness.mock_cursors.load).mockImplementation(async () => cursor);
  vi.mocked(harness.mock_cursors.save).mockImplementation(async (_ctx, saved) => {
    cursor = saved;
  });
  vi.mocked(harness.mock_manifests.find_latest_readable).mockImplementation(async () =>
    latest_readable(head),
  );
  vi.mocked(harness.mock_manifests.save).mockImplementation(async (_ctx, saved) => {
    head = saved;
  });
}

function saved_links(harness: MailboxSyncHarness): Record<string, string> {
  return vi.mocked(harness.mock_cursors.save).mock.lastCall![1].delta_links;
}

function prev_link_of_last_delta(harness: MailboxSyncHarness): string | undefined {
  return vi.mocked(harness.mock_connector.fetch_delta).mock.lastCall![3];
}

function entry_for(result: SyncResult, message_id: string): ManifestEntry | undefined {
  return result.manifest.entries.find((entry) => entry.object_id === message_id);
}

describe('a 4xx on the MIME download withholds the folder delta link (issue #849)', () => {
  let harness: MailboxSyncHarness;

  beforeEach(() => {
    harness = create_mailbox_sync_harness();
    persist_state_between_runs(harness);
    vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue(
      make_delta([make_message('msg-1', '{"id":"msg-1"}'), make_message('msg-2', '{}')], NEXT_LINK),
    );
  });

  it.each([
    [400, 'ErrorInvalidRequest'],
    [401, 'InvalidAuthenticationToken'],
    [404, 'ErrorItemNotFound'],
  ])(
    'names the message on %i %s, and the next run replaces the JSON entry with MIME',
    async (status, code) => {
      harness.mock_connector.fetch_mime = vi.fn(async (_t: string, _o: string, id: string) => {
        if (id === 'msg-1') throw graph_refusal(status, code);
        return MIME;
      });
      const first = await harness.service.sync_mailbox('t', OWNER);

      expect(first.summary.folder_errors).toEqual([
        `Inbox: message msg-1: original MIME not captured, stored from the JSON payload (HTTP ${status} ${code})`,
      ]);
      expect(entry_for(first, 'msg-1')?.payload_format).toBeUndefined();
      expect(entry_for(first, 'msg-1')?.mime_unavailable).toBeUndefined();
      expect(saved_links(harness)).toEqual({ 'folder-1': PREVIOUS_LINK });

      harness.mock_connector.fetch_mime = vi.fn().mockResolvedValue(MIME);
      const second = await harness.service.sync_mailbox('t', OWNER);

      expect(prev_link_of_last_delta(harness)).toBe(PREVIOUS_LINK);
      expect(second.summary.folder_errors).toEqual([]);
      expect(entry_for(second, 'msg-1')?.payload_format).toBe('mime');
      expect(saved_links(harness)).toEqual({ 'folder-1': NEXT_LINK });
    },
  );

  it('holds the link back once for a message deleted before its MIME was read', async () => {
    harness.mock_connector.fetch_mime = vi.fn(async (_t: string, _o: string, id: string) => {
      if (id === 'msg-1') throw graph_refusal(404, 'ErrorItemNotFound');
      return MIME;
    });
    await harness.service.sync_mailbox('t', OWNER);
    expect(saved_links(harness)).toEqual({ 'folder-1': PREVIOUS_LINK });

    vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue({
      ...make_delta([make_message('msg-2', '{}')], NEXT_LINK),
      removed_ids: ['msg-1'],
    });
    const second = await harness.service.sync_mailbox('t', OWNER);

    expect(prev_link_of_last_delta(harness)).toBe(PREVIOUS_LINK);
    expect(second.summary.folder_errors).toEqual([]);
    expect(entry_for(second, 'msg-1')).toBeUndefined();
    expect(saved_links(harness)).toEqual({ 'folder-1': NEXT_LINK });
  });
});
